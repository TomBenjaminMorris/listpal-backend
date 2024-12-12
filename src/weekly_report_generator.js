"use strict";
const { DynamoDBClient, QueryCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const client = new DynamoDBClient();
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const tableName = "ListPal-" + process.env.Env + "-Reports";
const { v4: uuidv4 } = require('uuid');
const { OpenAI } = require('openai');
const { zodResponseFormat } = require('openai/helpers/zod');
const { z } = require('zod');
const { OPENAI_API_KEY } = process.env;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const SummariesFormat = z.object({
  summaries: z.array(
    z.object({
      category: z.string(),
      summary: z.string(),
    })
  )
});

module.exports.handler = async (event) => {
  try {
    // Get all report tasks
    const taskData = await getAllReportTasks();

    // Group the tasks per user
    const groupedData = groupTasksPerUser(taskData);

    // Convert the task data into the LLM format
    const llmResult = convertTasksToLLM(groupedData);

    // Get AI summary report
    const summary = await getAISummary(llmResult);

    // Count the number of tasks per user
    const userCounts = countTasksPerUser(groupedData);

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
    return `Batch update failed: ${error}`;
  }
};

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

function allTasksQuery() {
  return {
    TableName: tableName,
    ScanIndexForward: true,
    ConsistentRead: false,
    KeyConditionExpression: "#cd420 = :cd420 And begins_with(#cd421, :cd421)",
    ProjectionExpression: "SK, Description, Category, Emoji, UserID",
    ExpressionAttributeValues: {
      ":cd420": { S: "t#" },
      ":cd421": { S: "t#" }
    },
    ExpressionAttributeNames: {
      "#cd420": "PK",
      "#cd421": "SK"
    }
  };
}

function addReportEntry(userID, score, summary) {
  return {
    Item: {
      PK: { S: userID },
      SK: { S: "rl#" + uuidv4() },
      Score: { N: String(score) },
      Summary: { S: summary },
      EntityType: { S: "ReportLine" }
    },
    TableName: tableName
  };
}

const getAllReportTasks = async () => {
  const allTasks = await query(allTasksQuery());
  return allTasks.Items.map((item) => unmarshall(item));
};

const groupTasksPerUser = (taskData) => {
  return taskData.reduce((acc, { UserID, Category, Description }) => {
    if (!acc[UserID]) {
      acc[UserID] = [];
    }
    acc[UserID].push({ Category, Description });
    return acc;
  }, {});
};

const convertTasksToLLM = (groupedData) => {
  const llmData = {};

  // Iterate over all users' tasks
  Object.values(groupedData).forEach((tasks) => {
    tasks.forEach(({ Category, Description }) => {
      if (!llmData[Category]) {
        llmData[Category] = [];
      }
      llmData[Category].push(Description);
    });
  });

  // Format the LLM data as a string
  return Object.entries(llmData)
    .map(([category, descriptions]) => {
      return `Category: ${category}\n${descriptions.map(desc => `* ${desc}`).join('\n')}\n`;
    })
    .join('\n');
};

const getAISummary = async (llmResult) => {
  const completion = await openai.beta.chat.completions.parse({
    model: "gpt-4o-mini",
    temperature: 0.8,
    max_tokens: 2048,
    messages: [
      {
        role: "system",
        content: "Using the category as context, summarise the bullet points into a weekly roundup in a paragraph or two. Ensure that the output is in the past-tense and written in second person format, keep the tone playful. Make sure to keep the categories separate and group them by category. Keep it to two sentences for each heading."
      },
      { role: "user", content: llmResult },
    ],
    response_format: zodResponseFormat(SummariesFormat, "summaries")
  });
  return JSON.stringify(completion.choices[0].message.parsed)
};

const countTasksPerUser = (groupedData) => {
  return Object.keys(groupedData).reduce((acc, userID) => {
    acc[userID] = groupedData[userID].length;
    return acc;
  }, {});
};
