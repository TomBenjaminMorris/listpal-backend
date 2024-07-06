"use strict";
const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { jwtDecode } = require("jwt-decode");
const client = new DynamoDBClient();
const tableName = "ListPal-" + process.env.Env

module.exports.handler = async (event) => {
  try {
    let result;
    const params = event.queryStringParameters;
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
          result = await query(activeTasksQuery(params.boardID));
          break;

        
        //// GET EXPIRED TASKS ////
        case "GET /expired-tasks": // Modify to set current date
          valid = await verifyBoard(userID, params.boardID);
          if (!valid) {
            return {
              error: "requested board does not belong to the currently logged in user"
            }
          }
          result = await query(expiredTasksQuery(params.boardID));
          break;
        
        
        //// GET ALL TASKS ////
        case "GET /all-tasks":
          result = await query(allTasksQuery(userID));
          break;
        
        
        //// GET TASKS ////
        case "GET /task":
          result = await query(taskQuery(userID, params.taskID));
          break;
      
        
        //// GET BOARDS ////
        case "GET /boards":
          result = await query(boardsPerUserQuery(userID));
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

async function verifyBoard(userID, boardID) {
  let returnVal = false
  const boards = await query(boardsPerUserQuery(userID));
  boards.Items.forEach(board => {
    console.log(board);
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