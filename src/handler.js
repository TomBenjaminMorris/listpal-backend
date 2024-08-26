"use strict";
const { DynamoDBClient, QueryCommand, UpdateItemCommand, PutItemCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { jwtDecode } = require("jwt-decode");
const client = new DynamoDBClient();
const tableName = "ListPal-" + process.env.Env;

module.exports.handler = async (event) => {
  try {
    let readResult, result;
    const params = event.queryStringParameters;
    const body = event.body && JSON.parse(event['body']);
    // console.log("TTT", JSON.stringify(body));
    const token = event.headers.authorization;
    const decoded = jwtDecode(token);
    const userID = `u#${decoded.sub}`;
    let valid = false

    switch (event.routeKey) {
      //// GET ACTIVE TASKS ////
      case "GET /active-tasks": // Modify to set current date
        valid = await verifyBoard(userID, params.boardID);
        if (!valid) {
          return {
            error: "requested board does not belong to the currently logged in user"
          }
        }
        readResult = await query(activeTasksQuery(params.boardID));
        break;


      //// GET EXPIRED TASKS ////
      case "GET /expired-tasks": // Modify to set current date
        valid = await verifyBoard(userID, params.boardID);
        if (!valid) {
          return {
            error: "requested board does not belong to the currently logged in user"
          }
        }
        readResult = await query(expiredTasksQuery(params.boardID));
        break;


      //// GET ALL TASKS ////
      case "GET /all-tasks":
        readResult = await query(allTasksQuery(userID));
        break;


      //// GET TASKS ////
      case "GET /task":
        readResult = await query(taskQuery(userID, params.taskID));
        break;


      //// GET BOARDS ////
      case "GET /boards":
        readResult = await query(boardsPerUserQuery(userID));
        break;


      //// GET USER ////
      case "GET /user":
        readResult = await query(getUser(userID));
        break;


      //// UPDATE TASK DESCRIPTION ////
      case "POST /task-description":
        result = await update(updateTaskDescription(userID, body.taskID, body.description));
        break;


      //// UPDATE TASK DETAILS ////
      case "POST /task-details":
        result = await update(updateTaskDetails(userID, body.taskID, body.completedDate, body.expiryDate, body.GSI1SK));
        break;


      //// ADD TASK ////
      case "POST /new-task":
        result = await add(addTask(userID, body));
        break;


      //// DELETE TASK ////
      case "POST /delete-task":
        result = await remove(deleteTask(userID, body.taskID));
        break;


      //// RENAME CATEGORY ////
      case "POST /rename-category":
        result = await renameCategory(userID, body.taskIDs, body.category);
        break;


      default:
        throw new Error(`Unsupported route: "${event.routeKey}"`);
    }

    const data = readResult && readResult.Items.map((item) => {
      return unmarshall(item);
    });

    return {
      // count: result.Count,
      // scannedCount: result.ScannedCount,
      data: data ? data : result
    }

  } catch (error) {
    console.log(error);
  }
}

async function verifyBoard(userID, boardID) {
  let returnVal = false
  const boards = await query(boardsPerUserQuery(userID));
  boards.Items.forEach(board => {
    if (board.SK.S == boardID) {
      returnVal = true
    }
  });
  return returnVal
}

async function query(input) {
  const command = new QueryCommand(input);
  const result = await client.send(command);
  return result
}

async function update(input) {
  const command = new UpdateItemCommand(input);
  const result = await client.send(command);
  return result
}

async function add(input) {
  const command = new PutItemCommand(input);
  const result = await client.send(command);
  return result
}

async function remove(input) {
  const command = new DeleteItemCommand(input);
  const result = await client.send(command);
  return result
}

function activeTasksQuery(boardID) {
  return {
    "TableName": tableName,
    "ScanIndexForward": true,
    "IndexName": "GSI1",
    "KeyConditionExpression": "#c1490 = :c1490 And #c1491 >= :c1491",
    // "ProjectionExpression": "SK, Description, Category, ExpiryDate",
    "ExpressionAttributeValues": {
      ":c1490": { "S": boardID },
      ":c1491": { "S": "1718751600000" }
    },
    "ExpressionAttributeNames": {
      "#c1490": "GSI1-PK",
      "#c1491": "GSI1-SK"
    }
  }
}

function expiredTasksQuery(boardID) {
  return {
    "TableName": tableName,
    "ScanIndexForward": true,
    "IndexName": "GSI1",
    "KeyConditionExpression": "#c1490 = :c1490 And #c1491 < :c1491",
    "ProjectionExpression": "SK, Description, Category, ExpiryDate",
    "ExpressionAttributeValues": {
      ":c1490": { "S": boardID },
      ":c1491": { "S": "1718751600000" }
    },
    "ExpressionAttributeNames": {
      "#c1490": "GSI1-PK",
      "#c1491": "GSI1-SK"
    }
  }
}

function allTasksQuery(userID) {
  return {
    "TableName": tableName,
    "ScanIndexForward": true,
    "ConsistentRead": false,
    "KeyConditionExpression": "#cd420 = :cd420 And begins_with(#cd421, :cd421)",
    "ProjectionExpression": "SK, Description, Category, ExpiryDate, CreatedDate, CompletedDate",
    "ExpressionAttributeValues": {
      ":cd420": { "S": userID },
      ":cd421": { "S": "t#" }
    },
    "ExpressionAttributeNames": {
      "#cd420": "PK",
      "#cd421": "SK"
    }
  }
}

function taskQuery(userID, taskID) {
  return {
    "TableName": tableName,
    "ScanIndexForward": true,
    "ConsistentRead": false,
    "KeyConditionExpression": "#cd420 = :cd420 And #cd421 = :cd421",
    "ProjectionExpression": "SK, Description, Category, ExpiryDate, CreatedDate, CompletedDate",
    "ExpressionAttributeValues": {
      ":cd420": { "S": userID },
      ":cd421": { "S": taskID }
    },
    "ExpressionAttributeNames": {
      "#cd420": "PK",
      "#cd421": "SK"
    }
  }
}

function boardsPerUserQuery(userID) {
  return {
    "TableName": tableName,
    "ScanIndexForward": true,
    "ConsistentRead": false,
    "KeyConditionExpression": "#cd420 = :cd420 And begins_with(#cd421, :cd421)",
    "ProjectionExpression": "SK, Board",
    "ExpressionAttributeValues": {
      ":cd420": { "S": userID },
      ":cd421": { "S": "b#" }
    },
    "ExpressionAttributeNames": {
      "#cd420": "PK",
      "#cd421": "SK"
    }
  }
}

function getUser(userID) {
  return {
    "TableName": tableName,
    "ScanIndexForward": true,
    "ConsistentRead": false,
    "KeyConditionExpression": "#cd420 = :cd420 And #cd421 = :cd421",
    "ProjectionExpression": "WScore, YTarget, MTarget, WTarget, MScore, Theme, YScore",
    "ExpressionAttributeValues": {
      ":cd420": { "S": userID },
      ":cd421": { "S": userID }
    },
    "ExpressionAttributeNames": {
      "#cd420": "PK",
      "#cd421": "SK"
    }
  }
}

function updateTaskDescription(userID, taskID, description) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": taskID }
    },
    "UpdateExpression": "SET #6e6a0 = :6e6a0",
    "ExpressionAttributeValues": {
      ":6e6a0": {
        "S": description
      }
    },
    "ExpressionAttributeNames": {
      "#6e6a0": "Description"
    }
  }
}

function updateTaskDetails(userID, taskID, completedDate, expiryDate, GSI1SK) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": taskID }
    },
    "UpdateExpression": "SET #9eb50 = :9eb50, #9eb51 = :9eb51, #9eb52 = :9eb52",
    "ExpressionAttributeValues": {
      ":9eb50": { "S": GSI1SK },
      ":9eb51": { "S": completedDate },
      ":9eb52": { "S": expiryDate }
    },
    "ExpressionAttributeNames": {
      "#9eb50": "GSI1-SK",
      "#9eb51": "CompletedDate",
      "#9eb52": "ExpiryDate"
    }
  }
}

function addTask(userID, body) {
  return {
    "Item": {
      "CreatedDate": { "S": body.createdDate },
      "GSI1-SK": { "S": body.expiryDate },
      "SK": { "S": body.taskID },
      "ExpiryDate": { "S": body.expiryDate },
      "GSI1-PK": { "S": body.boardID },
      "Description": { "S": body.description },
      "PK": { "S": userID },
      "CompletedDate": { "S": body.completedDate },
      "Category": { "S": body.category },
      "EntityType": { "S": "Task" },
    },
    "TableName": tableName
  }
}

function deleteTask(userID, taskID) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": taskID }
    }
  }
}

async function renameCategory(userID, taskIDs, category) {
  let result = []
  try {
    for (const id of taskIDs) {
      const data = await update(getRenameCommand(userID, id, category));
      result.push(data)
    }
    return result
  } catch (e) {
    return "Batch update failed: " + e;
  }
}

function getRenameCommand(userID, taskID, category) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": taskID }
    },
    "UpdateExpression": "SET #6e6a0 = :6e6a0",
    "ExpressionAttributeValues": {
      ":6e6a0": {
        "S": category
      }
    },
    "ExpressionAttributeNames": {
      "#6e6a0": "Category"
    }
  }
}

