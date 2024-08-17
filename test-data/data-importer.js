import { DynamoDBClient, BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";
import dataTypes from "dynamodb-data-types";
const attr = dataTypes.AttributeValue
import * as fs from 'node:fs';

const dynamoTableName = 'ListPal-Dev-2';
const importFile = './exports/ListPal-Dev-Test-Data-2024-08-17.json';

let rawdata = fs.readFileSync(importFile);
let json_data = JSON.parse(rawdata);
const REGION = "eu-west-2";
const dbclient = new DynamoDBClient({ region: REGION });

// JSON - Insert to Dynamo Table
const insertToDynamoTable = async function (json) {
    try {

        let dynamoDBRecords = getDynamoDBRecords(json)
        var batches = [];

        while (dynamoDBRecords.length) {
            batches.push(dynamoDBRecords.splice(0, 25));
        }

        await callDynamoDBInsert(batches)

    } catch (error) {
        console.log(error);
        return error;
    }
}

const callDynamoDBInsert = async function (batches) {
    return Promise.all(
        batches.map(async (batch) => {
            let requestItems = {}
            requestItems[dynamoTableName] = batch

            var params = {
                RequestItems: requestItems
            };

            await dbclient.send(new BatchWriteItemCommand(params))
        })
    );
}

// Get DynamoDB records from json
const getDynamoDBRecords = function (data) {

    let dynamoDBRecords = data.map(entity => {
        entity = attr.wrap(entity)
        console.log(entity)
        let dynamoRecord = Object.assign({ PutRequest: { Item: entity } })
        return dynamoRecord
    })

    return dynamoDBRecords
}


// Create DynamoDB service object
const run = async () => {
    try {
        const data = await insertToDynamoTable(json_data)
        console.log("Success, items inserted", data);
    } catch (err) {
        console.log("Error", err);
    }
};
run();
