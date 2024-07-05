"use strict";
const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
const client = new DynamoDBClient();
const tableName = "ListPal-" + process.env.Env

module.exports.handler = async (event) => {
    try {
      let result, command
      const params = event.queryStringParameters
      
      switch (event.routeKey) {
        case "GET /active-tasks": // Modify to set current date
          command = new QueryCommand(activeTasksQuery(params.boardID));
          result = await client.send(command);
          break;

        case "GET /expired-tasks": // Modify to set current date
          command = new QueryCommand(expiredTasksQuery(params.boardID));
          result = await client.send(command);
          break;
        
        case "GET /all-tasks":
          command = new QueryCommand(allTasksQuery(params.userID));
          result = await client.send(command);
          break;
      
        case "GET /task":
          command = new QueryCommand(taskQuery(params.userID, params.taskID));
          result = await client.send(command);
          break;
      
        case "GET /boards":
          command = new QueryCommand(boardsPerUserQuery(params.userID));
          result = await client.send(command);
          break;

          default:
            throw new Error(`Unsupported route: "${event.routeKey}"`);
      }
          
      return {
        count: result.Count,
        scannedCount: result.ScannedCount,
        data: result.Items
      }
      
    } catch (error) {
      console.log(error);
    }
}

function activeTasksQuery(boardID) {
  return {
    "TableName": tableName,
    "ScanIndexForward": true,
    "IndexName": "GSI1",
    "KeyConditionExpression": "#c1490 = :c1490 And #c1491 >= :c1491",
    "ProjectionExpression": "SK, Description, Category, ExpiryDate",
    "ExpressionAttributeValues": {
      ":c1490": {
        "S": boardID
      },
      ":c1491": {
        "S": "2024-06-19"
      }
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
      ":c1490": {
        "S": boardID
      },
      ":c1491": {
        "S": "2024-06-19"
      }
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
      ":cd420": {
        "S": userID
      },
      ":cd421": {
        "S": "t#"
      }
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
      ":cd420": {
        "S": userID
      },
      ":cd421": {
        "S": taskID
      }
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
      ":cd420": {
        "S": userID
      },
      ":cd421": {
        "S": "b#"
      }
    },
    "ExpressionAttributeNames": {
      "#cd420": "PK",
      "#cd421": "SK"
    }
  }
}