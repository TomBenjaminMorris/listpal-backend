"use strict";

const { DynamoDBClient, QueryCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { SSMClient, GetParameterCommand } = require("@aws-sdk/client-ssm");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { OpenAI } = require("openai");
const { zodResponseFormat } = require("openai/helpers/zod");
const { z } = require("zod");

const client = new DynamoDBClient();
const ssm = new SSMClient();
const tableName = `ListPal-${process.env.Env}-Reports`;

const SummariesFormat = z.object({
  summaries: z.array(z.object({ category: z.string(), summary: z.string() })),
});

const openai = new OpenAI({ apiKey: "" }); // We'll initialize the API key later.

async function fetchAPIKey() {
  try {
    const { Parameter } = await ssm.send(new GetParameterCommand({
      Name: process.env.OPENAI_API_KEY_PATH,
      WithDecryption: true,
    }));
    return Parameter.Value;
  } catch (error) {
    console.error("Error fetching API key from Parameter Store:", error);
    throw new Error("Failed to retrieve API key.");
  }
}

async function query(input) {
  const command = new QueryCommand(input);
  const result = await client.send(command);
  return result;
}

async function add(input) {
  const command = new PutItemCommand(input);
  const result = await client.send(command);
  return result;
}

// Get all report tasks
async function getAllReportTasks() {
  const allTasks = await query(allTasksQuery());
  return allTasks.Items.map((item) => unmarshall(item));
}

function allTasksQuery() {
  return {
    TableName: tableName,
    ScanIndexForward: true,
    ConsistentRead: false,
    KeyConditionExpression: "#cd420 = :cd420 And begins_with(#cd421, :cd421)",
    ProjectionExpression: "SK, Description, Category, Emoji, UserID",
    ExpressionAttributeValues: {
      ":cd420": { S: "t#" },
      ":cd421": { S: "t#" },
    },
    ExpressionAttributeNames: {
      "#cd420": "PK",
      "#cd421": "SK",
    },
  };
}

function addReportEntry(userID, score, summary) {
  return {
    Item: {
      PK: { S: userID },
      SK: { S: "rl#" + uuidv4() },
      Score: { N: String(score) },
      Summary: { S: summary },
      EntityType: { S: "ReportLine" },
      WOTY: { N: String(getCurrentWeekOfYear() - 1) }, // Week of the year - 1
    },
    TableName: tableName,
  };
}

// Utility function to count tasks per user
const countTasksPerUser = (groupedData) => {
  return Object.keys(groupedData).reduce((acc, userID) => {
    acc[userID] = groupedData[userID].length;
    return acc;
  }, {});
};

function getCurrentWeekOfYear() {
  const now = new Date();
  const startOfYear = new Date(now.getFullYear(), 0, 1);
  const daysSinceStartOfYear = Math.floor((now - startOfYear) / (1000 * 60 * 60 * 24));
  const weekNumber = Math.ceil((daysSinceStartOfYear + 1) / 7); // +1 to adjust for 1st day of the year
  return weekNumber;
}

function groupTasksPerUser(taskData) {
  return taskData.reduce((acc, { UserID, Category, Description }) => {
    if (!acc[UserID]) acc[UserID] = [];
    acc[UserID].push({ Category, Description });
    return acc;
  }, {});
}

function convertTasksToLLM(groupedData) {
  const llmData = {};

  // Group tasks by category
  Object.values(groupedData).forEach((tasks) => {
    tasks.forEach(({ Category, Description }) => {
      if (!llmData[Category]) llmData[Category] = [];
      llmData[Category].push(Description);
    });
  });

  // Convert to a string format
  return Object.entries(llmData)
    .map(
      ([category, descriptions]) =>
        `Category: ${category}\n${descriptions.map((desc) => `* ${desc}`).join("\n")}\n`
    )
    .join("\n");
}

async function getAISummary(llmResult) {
  const completion = await openai.beta.chat.completions.parse({
    model: "gpt-4o-mini",
    temperature: 0.8,
    max_tokens: 2048,
    messages: [
      {
        role: "system",
        content:
          "Using the category as context, summarise the bullet points into a weekly roundup in a paragraph or two. Ensure that the output is in the past-tense and written in second person format, keep the tone playful. Make sure to keep the categories separate and group them by category. Keep it to two sentences for each heading.",
      },
      { role: "user", content: llmResult },
    ],
    response_format: zodResponseFormat(SummariesFormat, "summaries"),
  });
  return JSON.stringify(completion.choices[0].message.parsed);
}

module.exports.handler = async (event) => {
  try {
    // Fetch API key and initialize OpenAI client
    const apiKey = await fetchAPIKey();
    openai.apiKey = apiKey;

    // Get all report tasks
    const taskData = await getAllReportTasks();

    // Group tasks per user
    const groupedData = groupTasksPerUser(taskData);

    // Convert tasks into LLM format
    const llmResult = convertTasksToLLM(groupedData);

    // Get AI summary
    const summary = await getAISummary(llmResult);

    // Count tasks per user
    const userCounts = countTasksPerUser(groupedData);

    // Add report entries for each user
    const result = await Promise.all(
      Object.keys(groupedData).map(async (userID) => {
        const writeResult = await add(addReportEntry(userID, userCounts[userID], summary));
        return writeResult;
      })
    );

    console.log("Successfully added report lines");
    return result;

  } catch (error) {
    console.error("Error processing report:", error);
    return `Batch update failed: ${error.message}`;
  }
};
