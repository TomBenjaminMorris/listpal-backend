"use strict";
const { DynamoDBClient, QueryCommand, UpdateItemCommand, PutItemCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { jwtDecode } = require("jwt-decode");
const client = new DynamoDBClient();
const tableName = "ListPal-" + process.env.Env;
const reportTableName = "ListPal-" + process.env.Env + "-Reports";

module.exports.handler = async (event) => {
  try {
    let readResult, writeResult;
    const params = event.queryStringParameters;
    const body = event.body && JSON.parse(event['body']);
    let userID = "";
    // console.log("TTT", JSON.stringify(body));
    if (event.headers.authorization) {
      const token = event.headers.authorization;
      const decoded = jwtDecode(token);
      userID = `u#${decoded.sub}`;
    }
    let valid = false

    switch (event.routeKey) {
      //// GET ACTIVE TASKS ////
      case "GET /active-tasks":
        valid = await verifyBoard(userID, params.boardID);
        if (!valid) {
          return {
            error: "requested board does not belong to the currently logged in user"
          }
        }
        readResult = await query(activeTasksQuery(params.boardID));
        break;


      //// GET EXPIRED TASKS ////
      case "GET /expired-tasks":
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


      //// GET WEEKLY REPORTS ////
      case "GET /weekly-reports":
        readResult = await query(getReports(userID));
        break;


      //// GET STATS ////
      case "GET /stats":
        readResult = await query(getStats(userID));
        break;


      //// ADD USER ////
      case "POST /new-user":
        writeResult = await add(addUser(body));
        const boardBody = { userID: body.userID, boardName: "Demo Board", boardID: "b#" + body.userID }
        await add(addBoard(body.userID, boardBody));
        const taskBody = { userID: body.userID, createdDate: "nil", expiryDate: "nil", taskID: "t#" + body.userID, description: "Start creating some new tasks!", completedDate: "nil", category: "Welcome", emoji: "✅", boardID: "b#" + body.userID }
        await add(addTask(body.userID, taskBody));
        break;


      //// UPDATE USER THEME ////
      case "POST /user-theme":
        writeResult = await update(updateUserTheme(userID, body.theme));
        break;


      //// SYNC TASK CHANGES ////
      case "POST /task-sync":
        try {
          writeResult = await handleTaskSync(userID, body.task_actions);
        } catch (error) {
          console.error("Error during task synchronisation:", error);
          return {
            statusCode: 500,
            body: JSON.stringify({
              message: "An error occurred while syncing tasks.",
              error: error.message || "Unknown error",
            }),
          };
        }
        break;


      //// UPDATE TASK DESCRIPTION ////
      case "POST /task-description":
        writeResult = await update(updateTaskDescription(userID, body.taskID, body.description));
        break;


      //// UPDATE TASK DETAILS ////
      case "POST /task-details":
        writeResult = await update(updateTaskDetails(userID, body.taskID, body.completedDate, body.expiryDate, body.GSI1SK, body.expiryDateTTL, body.link));
        break;


      //// UPDATE TASK CHECKED ////
      case "POST /task-checked":
        try {
          const writeResultMulti = [];
          // Update task details
          const updateResult = updateTaskDetails(userID, body.taskID, body.completedDate, body.expiryDate, body.GSI1SK, body.expiryDateTTL, body.link);
          writeResultMulti.push(await update(updateResult));
          // Conditionally add or remove the report task based on the 'checked' value
          if (body.checked) {
            const addResult = addReportTask(userID, body);
            writeResultMulti.push(await add(addResult));
          } else {
            const deleteResult = deleteReportTask(body.taskID);
            writeResultMulti.push(await remove(deleteResult));
          }
          // Wait for all operations to complete concurrently
          const results = await Promise.all(writeResultMulti);
          // Set the final result if needed
          writeResult = results;
        } catch (error) {
          console.error("Error updating task checked:", error);
          // Handle the error (e.g., return a meaningful error message or re-throw)
          writeResult = { error: "Task update failed", details: error.message };
        }
        break;


      //// UPDATE TASK IMPORTANCE ////
      case "POST /task-important":
        writeResult = await update(updateTaskImportance(userID, body.taskID, body.isImportant));
        break;


      //// ADD TASK ////
      case "POST /new-task":
        writeResult = await add(addTask(userID, body));
        break;


      //// DELETE TASK ////
      case "POST /delete-task":
        writeResult = await remove(deleteTask(userID, body.taskID));
        break;


      //// RENAME CATEGORY ////
      case "POST /rename-category":
        writeResult = await renameCategory(userID, body.taskIDs, body.category);
        break;


      //// ADD BOARD ////
      case "POST /new-board":
        writeResult = await add(addBoard(userID, body));
        break;


      //// RENAME BOARD ////
      case "POST /rename-board":
        writeResult = await update(renameBoard(userID, body.boardID, body.name));
        break;


      //// CARD EMOJI ////
      case "POST /card-emoji":
        writeResult = await updateCardEmoji(userID, body.taskIDs, body.emoji);
        break;


      //// BOARD EMOJI ////
      case "POST /board-emoji":
        writeResult = await update(updateBoardEmoji(userID, body.boardID, body.emoji));
        break;


      //// BOARD CATEGORY ORDER ////
      case "POST /board-category-order":
        writeResult = await update(updateBoardCategoryOrder(userID, body.boardID, body.categoryOrder));
        break;


      //// DELETE BOARD ////
      case "POST /delete-board":
        valid = await verifyBoard(userID, body.boardID);
        if (!valid) {
          return {
            error: "Requested board does not belong to the currently logged-in user"
          };
        }

        try {
          await deleteBoardTasks(userID, body.boardID);
          const boardDeletionResult = await remove(deleteBoard(userID, body.boardID));
          return boardDeletionResult;
        } catch (error) {
          console.error("Failed to delete board or tasks:", error);
          return {
            error: "Failed to delete board and/or tasks",
            details: error.message
          };
        }


      //// UPDATE BOARD SCORES ////
      case "POST /board-scores":
        try {
          const writeResultMulti = [];
          // Update board scores details
          const scoreResult = updateBoardScores(userID, body.boardID, body.scores);
          writeResultMulti.push(await update(scoreResult));
          // If a task is defined in the request
          if (body.task) {
            // Conditionally add or remove the report task based on the 'checked' value
            if (body.task.checked) {
              const addResult = addReportTask(userID, body.task);
              writeResultMulti.push(await add(addResult));
            } else {
              const deleteResult = deleteReportTask(body.task.taskID);
              writeResultMulti.push(await remove(deleteResult));
            }
          }
          // Wait for all operations to complete concurrently
          const results = await Promise.all(writeResultMulti);
          // Set the final result if needed
          writeResult = results;
        } catch (error) {
          console.error("Error updating scores or task reports:", error);
          writeResult = { error: "Task/Score update failed", details: error.message };
        }
        break;


      //// UPDATE BOARD TARGETS ////
      case "POST /board-targets":
        writeResult = await update(updateBoardTargets(userID, body.boardID, body.targets));
        break;


      default:
        throw new Error(`Unsupported route: "${event.routeKey}"`);
    }

    const data = readResult && readResult.Items.map((item) => {
      return unmarshall(item);
    });

    return {
      data: data ? data : writeResult
    }

  } catch (error) {
    console.log(error);
  }
}


///////////////////// SYNC FUNCTIONALITY START /////////////////////
async function initializeTaskValues(task) {
  return {
    ...task,
    ExpiryDateTTL: task.ExpiryDateTTL || 0,
    ExpiryDate: task.ExpiryDate || '',
    Description: task.Description || '',
    Category: task.Category || '',
    'GSI1-SK': task['GSI1-SK'] || '',
    CompletedDate: task.CompletedDate || '',
    Important: task.Important || '',
    Link: task.Link || ''
  };
}

async function handleTaskSync(userID, tasks) {
  const promises = tasks.map(async (task_action) => {
    let result;
    const taskID = task_action.SK;
    const initializedTask = await initializeTaskValues(task_action);
    switch (task_action.Action) {
      case "create":
        result = await add(addTaskSync(userID, initializedTask));
        return {
          ...result,
          action: "create",
          taskId: taskID
        };
      case "delete":
        result = await remove(deleteTaskSync(userID, taskID));
        return {
          ...result,
          action: "delete",
          taskId: taskID
        };
      case "update":
        result = await update(updateTaskSync(userID, initializedTask));
        return {
          ...result,
          action: "update",
          taskId: taskID
        };
      default:
        return null;
    }
  });
  return await Promise.all(promises);
}

function updateTaskSync(userID, task) {
  return {
    TableName: tableName,
    Key: {
      PK: { "S": userID },
      SK: { "S": task.SK }
    },
    UpdateExpression: "SET ExpiryDateTTL = :ttl, ExpiryDate = :expiry, Description = :desc, Category = :cat, #gsi1sk = :gsi1sk, CompletedDate = :completed, Important = :important, Link = :link",
    ExpressionAttributeValues: {
      ":ttl": { "N": String(task.ExpiryDateTTL) },
      ":expiry": { "S": task.ExpiryDate },
      ":desc": { "S": task.Description },
      ":cat": { "S": task.Category },
      ":gsi1sk": { "S": task['GSI1-SK'] },
      ":completed": { "S": task.CompletedDate },
      ":important": { "S": task.Important },
      ":link": { "S": task.Link },
    },
    ExpressionAttributeNames: {
      "#gsi1sk": "GSI1-SK"
    }
  };
}

function addTaskSync(userID, body) {
  return {
    "TableName": tableName,
    "Item": {
      "CreatedDate": { "S": body.CreatedDate },
      "GSI1-SK": { "S": body.ExpiryDate },
      "SK": { "S": body.SK },
      "ExpiryDate": { "S": "nil" },
      "ExpiryDateTTL": { "N": "0" },
      "GSI1-PK": { "S": body["GSI1-PK"] },
      "GSI1-SK": { "S": "nil" },
      "Description": { "S": body.Description },
      "PK": { "S": userID },
      "CompletedDate": { "S": "nil" },
      "Category": { "S": body.Category },
      "EntityType": { "S": "Task" },
      "Emoji": { "S": body.Emoji },
    }
  }
}

function deleteTaskSync(userID, taskID) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": taskID }
    }
  }
}
///////////////////// SYNC FUNCTIONALITY END /////////////////////


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
    "ExpressionAttributeValues": {
      ":c1490": { "S": boardID },
      ":c1491": { "S": String(Date.now()) }
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
      ":c1491": { "S": String(Date.now()) }
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
    "ProjectionExpression": "SK, Board, WScore, MScore, YScore, YTarget, MTarget, WTarget, Emoji, CategoryOrder",
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
    "ProjectionExpression": "Theme",
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

function getReports(userID) {
  return {
    "TableName": reportTableName,
    "ScanIndexForward": true,
    "ConsistentRead": false,
    "Limit": 10,
    "KeyConditionExpression": "#cd420 = :cd420 And begins_with(#cd421, :cd421)",
    "ProjectionExpression": "SK, Summary, Score, WOTY, YearNum",
    "ExpressionAttributeValues": {
      ":cd420": { "S": userID },
      ":cd421": { "S": "rl#" }
    },
    "ExpressionAttributeNames": {
      "#cd420": "PK",
      "#cd421": "SK"
    }
  }
}

function getStats(userID) {
  return {
    "TableName": reportTableName,
    "ScanIndexForward": true,
    "ConsistentRead": false,
    "KeyConditionExpression": "#cd420 = :cd420 And begins_with(#cd421, :cd421)",
    "ProjectionExpression": "SK, Score, WOTY, YearNum",
    "ExpressionAttributeValues": {
      ":cd420": { "S": userID },
      ":cd421": { "S": "rl#" }
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

function updateTaskImportance(userID, taskID, isImportant) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": taskID }
    },
    "UpdateExpression": "SET #6e6a0 = :6e6a0",
    "ExpressionAttributeValues": {
      ":6e6a0": {
        "S": isImportant
      }
    },
    "ExpressionAttributeNames": {
      "#6e6a0": "Important"
    }
  }
}

function updateTaskDetails(userID, taskID, completedDate, expiryDate, GSI1SK, expiryDateTTL, link) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": taskID }
    },
    "UpdateExpression": "SET #9eb50 = :9eb50, #9eb51 = :9eb51, #9eb52 = :9eb52, #9eb53 = :9eb53, #9eb54 = :9eb54",
    "ExpressionAttributeValues": {
      ":9eb50": { "S": GSI1SK },
      ":9eb51": { "S": completedDate },
      ":9eb52": { "S": expiryDate },
      ":9eb53": { "N": String(expiryDateTTL) },
      ":9eb54": { "S": link },
    },
    "ExpressionAttributeNames": {
      "#9eb50": "GSI1-SK",
      "#9eb51": "CompletedDate",
      "#9eb52": "ExpiryDate",
      "#9eb53": "ExpiryDateTTL",
      "#9eb54": "Link",
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
      "ExpiryDateTTL": { "N": "0" },
      "GSI1-PK": { "S": body.boardID },
      "Description": { "S": body.description },
      "PK": { "S": userID },
      "CompletedDate": { "S": body.completedDate },
      "Category": { "S": body.category },
      "EntityType": { "S": "Task" },
      "Emoji": { "S": body.emoji },
    },
    "TableName": tableName
  }
}

function addReportTask(userID, body) {
  return {
    "Item": {
      "PK": { "S": "t#" },
      "SK": { "S": body.taskID },
      "ExpiryDateTTL": { "N": "0" },
      "Description": { "S": body.description },
      "UserID": { "S": userID },
      "Category": { "S": body.category },
      "EntityType": { "S": "Task" },
      "Emoji": { "S": body.emoji },
      "ExpiryDateTTL": { "N": String(getNextMondayTimestamp()) },
    },
    "TableName": reportTableName
  }
}

function getNextMondayTimestamp() {
  var d = new Date();
  d.setDate(d.getDate() + (((1 + 7 - d.getDay()) % 7) || 7));
  return Math.floor(d / 1000) + 3600;
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

function deleteReportTask(taskID) {
  return {
    "TableName": reportTableName,
    "Key": {
      "PK": { "S": "t#" },
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

async function updateCardEmoji(userID, taskIDs, emoji) {
  let result = []
  try {
    for (const id of taskIDs) {
      const data = await update(getCardEmojiCommand(userID, id, emoji));
      result.push(data)
    }
    return result
  } catch (e) {
    return "Batch update failed: " + e;
  }
}

function getCardEmojiCommand(userID, taskID, emoji) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": taskID }
    },
    "UpdateExpression": "SET #6e6a0 = :6e6a0",
    "ExpressionAttributeValues": {
      ":6e6a0": {
        "S": emoji
      }
    },
    "ExpressionAttributeNames": {
      "#6e6a0": "Emoji"
    }
  }
}

function updateUserTheme(userID, theme) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": userID }
    },
    "UpdateExpression": "SET #9eb52 = :9eb52",
    "ExpressionAttributeValues": {
      ":9eb52": { "S": theme }
    },
    "ExpressionAttributeNames": {
      "#9eb52": "Theme"
    }
  }
}

function addBoard(userID, body) {
  return {
    "Item": {
      "SK": { "S": body.boardID },
      "PK": { "S": userID },
      "Board": { "S": body.boardName },
      "EntityType": { "S": "Board" },
      "WScore": { "N": String(0) },
      "MScore": { "N": String(0) },
      "YScore": { "N": String(0) },
      "WTarget": { "N": String(7) },
      "MTarget": { "N": String(31) },
      "YTarget": { "N": String(365) },
      "GSI1-SK": { "S": body.boardID },
      "GSI1-PK": { "S": "b#" },
      "Emoji": { "S": "🚀" },
      "CategoryOrder": { "S": "[]" },
    },
    "TableName": tableName
  }
}

function renameBoard(userID, boardID, name) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": boardID }
    },
    "UpdateExpression": "SET #6e6a0 = :6e6a0",
    "ExpressionAttributeValues": {
      ":6e6a0": {
        "S": name
      }
    },
    "ExpressionAttributeNames": {
      "#6e6a0": "Board"
    }
  }
}

function updateBoardEmoji(userID, boardID, emoji) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": boardID }
    },
    "UpdateExpression": "SET #6e6a0 = :6e6a0",
    "ExpressionAttributeValues": {
      ":6e6a0": {
        "S": emoji
      }
    },
    "ExpressionAttributeNames": {
      "#6e6a0": "Emoji"
    }
  }
}

function updateBoardCategoryOrder(userID, boardID, categoryOrder) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": boardID }
    },
    "UpdateExpression": "SET #6e6a0 = :6e6a0",
    "ExpressionAttributeValues": {
      ":6e6a0": {
        "S": categoryOrder
      }
    },
    "ExpressionAttributeNames": {
      "#6e6a0": "CategoryOrder"
    }
  }
}

function deleteBoard(userID, boardID) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": boardID }
    }
  }
}

async function deleteBoardTasks(userID, boardID) {
  try {
    const readResult = await query(activeTasksQuery(boardID));
    console.log("Read tasks:", JSON.stringify(readResult));

    if (!readResult.Items || readResult.Items.length === 0) {
      console.log("No tasks found for board", boardID);
      return;
    }

    const deletePromises = readResult.Items.map(task => {
      return remove(deleteTask(userID, task.SK.S));
    });

    await Promise.all(deletePromises);
    console.log("All tasks deleted successfully");
  } catch (error) {
    console.error("Error deleting tasks for board:", boardID, error);
    throw new Error(`Batch update failed: ${error.message}`);
  }
}


function updateBoardScores(userID, boardID, scores) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": boardID }
    },
    "UpdateExpression": "SET #9eb50 = :9eb50, #9eb51 = :9eb51, #9eb52 = :9eb52",
    "ExpressionAttributeValues": {
      ":9eb50": { "N": String(scores.YScore) },
      ":9eb51": { "N": String(scores.MScore) },
      ":9eb52": { "N": String(scores.WScore) }
    },
    "ExpressionAttributeNames": {
      "#9eb50": "YScore",
      "#9eb51": "MScore",
      "#9eb52": "WScore"
    }
  }
}

function updateBoardTargets(userID, boardID, targets) {
  return {
    "TableName": tableName,
    "Key": {
      "PK": { "S": userID },
      "SK": { "S": boardID }
    },
    "UpdateExpression": "SET #9eb50 = :9eb50, #9eb51 = :9eb51, #9eb52 = :9eb52",
    "ExpressionAttributeValues": {
      ":9eb50": { "N": String(targets.YTarget) },
      ":9eb51": { "N": String(targets.MTarget) },
      ":9eb52": { "N": String(targets.WTarget) }
    },
    "ExpressionAttributeNames": {
      "#9eb50": "YTarget",
      "#9eb51": "MTarget",
      "#9eb52": "WTarget"
    }
  }
}

function addUser(body) {
  return {
    "Item": {
      "SK": { "S": body.userID },
      "PK": { "S": body.userID },
      "Email": { "S": body.email },
      "Name": { "S": body.name },
      "EntityType": { "S": "User" },
      "GSI1-SK": { "S": body.userID },
      "GSI1-PK": { "S": "u#" },
      "Theme": { "S": "purple-haze" },
    },
    "TableName": tableName
  }
}
