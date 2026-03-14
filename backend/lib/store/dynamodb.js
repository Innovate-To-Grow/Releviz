import crypto from "crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

const DEFAULT_TABLES = {
  events: process.env.DDB_EVENTS_TABLE || "scheduler-prod-events",
  participants: process.env.DDB_PARTICIPANTS_TABLE || "scheduler-prod-participants",
  weights: process.env.DDB_WEIGHTS_TABLE || "scheduler-prod-weights",
  users: process.env.DDB_USERS_TABLE || "scheduler-prod-users",
  userEvents: process.env.DDB_USER_EVENTS_TABLE || "scheduler-prod-user-events",
};

function isConditionalCheckFailed(err) {
  return err?.name === "ConditionalCheckFailedException";
}

function mapEvent(item) {
  if (!item) return null;
  return {
    eventCode: item.eventCode,
    eventId: item.eventId,
    name: item.name,
    passwordHash: item.passwordHash,
    startHour: Number(item.startHour),
    endHour: Number(item.endHour),
    days: Array.isArray(item.days) ? item.days.map(Number) : [1, 2, 3, 4, 5],
    mode: item.mode || "inperson",
    location: item.location || "",
    organizerUserId: item.organizerUserId || null,
    participantVerification: item.participantVerification || "none",
    participantViewPermission: item.participantViewPermission || "own_only",
    daySelectionType: item.daySelectionType || "days_of_week",
    specificDates: item.specificDates || null,
    createdAt: item.createdAt,
  };
}

function mapParticipant(item) {
  if (!item) return null;
  return {
    eventCode: item.eventCode,
    eventId: item.eventId,
    participantName: item.participantName,
    participantId: item.participantId,
    scheduleInperson: item.scheduleInperson,
    scheduleVirtual: item.scheduleVirtual,
    submitted: Number(item.submitted) ? 1 : 0,
    hidden: Number(item.hidden) ? 1 : 0,
    groupName: item.groupName || null,
    sortOrder: item.sortOrder !== undefined ? Number(item.sortOrder) : null,
    createdAt: item.createdAt,
  };
}

function mapWeight(item) {
  if (!item) return null;
  return {
    eventCode: item.eventCode,
    participantName: item.participantName,
    weight: Number(item.weight),
    included: Number(item.included) ? 1 : 0,
  };
}

export class DynamoSchedulerStore {
  constructor({ docClient, tables = DEFAULT_TABLES } = {}) {
    const region = process.env.AWS_REGION || "us-west-2";
    if (docClient && typeof docClient.send === "function") {
      this.doc = docClient;
    } else {
      const client = new DynamoDBClient({ region });
      this.doc = DynamoDBDocumentClient.from(client, {
        marshallOptions: { removeUndefinedValues: true },
      });
    }
    this.tables = tables;
  }

  async getEvent(eventCode) {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tables.events,
        Key: { eventCode },
      })
    );
    return mapEvent(res.Item);
  }

  async createEvent(event) {
    const item = {
      eventCode: event.eventCode,
      eventId: event.eventId || crypto.randomUUID(),
      name: event.name,
      passwordHash: event.passwordHash,
      startHour: event.startHour,
      endHour: event.endHour,
      days: event.days,
      mode: event.mode,
      location: event.location || "",
      organizerUserId: event.organizerUserId || undefined,
      participantVerification: event.participantVerification || undefined,
      participantViewPermission: event.participantViewPermission || undefined,
      daySelectionType: event.daySelectionType || undefined,
      specificDates: event.specificDates || undefined,
      createdAt: event.createdAt || new Date().toISOString(),
    };

    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tables.events,
          Item: item,
          ConditionExpression: "attribute_not_exists(eventCode)",
        })
      );
      return true;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return false;
      throw err;
    }
  }

  async listParticipants(eventCode) {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.participants,
        KeyConditionExpression: "eventCode = :eventCode",
        ExpressionAttributeValues: {
          ":eventCode": eventCode,
        },
      })
    );
    return (res.Items || []).map(mapParticipant);
  }

  async listParticipantNames(eventCode) {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.participants,
        KeyConditionExpression: "eventCode = :eventCode",
        ProjectionExpression: "participantName",
        ExpressionAttributeValues: {
          ":eventCode": eventCode,
        },
      })
    );
    return (res.Items || []).map((item) => item.participantName);
  }

  async getParticipant(eventCode, participantName) {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tables.participants,
        Key: { eventCode, participantName },
      })
    );
    return mapParticipant(res.Item);
  }

  async createParticipantIfAbsent({
    eventCode,
    eventId,
    participantName,
    scheduleInperson,
    scheduleVirtual,
  }) {
    const item = {
      eventCode,
      eventId,
      participantName,
      participantId: crypto.randomUUID(),
      scheduleInperson,
      scheduleVirtual,
      submitted: 0,
      createdAt: new Date().toISOString(),
    };

    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tables.participants,
          Item: item,
          ConditionExpression:
            "attribute_not_exists(eventCode) AND attribute_not_exists(participantName)",
        })
      );
      return { participant: mapParticipant(item), created: true };
    } catch (err) {
      if (!isConditionalCheckFailed(err)) throw err;
      const existing = await this.getParticipant(eventCode, participantName);
      return { participant: existing, created: false };
    }
  }

  async updateParticipant(eventCode, participantName, updates) {
    const existing = await this.getParticipant(eventCode, participantName);
    if (!existing) return null;

    const next = {
      ...existing,
      ...(updates.scheduleInperson !== undefined
        ? { scheduleInperson: updates.scheduleInperson }
        : {}),
      ...(updates.scheduleVirtual !== undefined
        ? { scheduleVirtual: updates.scheduleVirtual }
        : {}),
      ...(updates.submitted !== undefined ? { submitted: updates.submitted ? 1 : 0 } : {}),
      ...(updates.hidden !== undefined ? { hidden: updates.hidden ? 1 : 0 } : {}),
      ...(updates.groupName !== undefined ? { groupName: updates.groupName } : {}),
      ...(updates.sortOrder !== undefined ? { sortOrder: updates.sortOrder } : {}),
    };

    await this.doc.send(
      new PutCommand({
        TableName: this.tables.participants,
        Item: next,
      })
    );

    return mapParticipant(next);
  }

  async deleteParticipantAndWeight(eventCode, participantName) {
    await this.doc.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Delete: {
              TableName: this.tables.participants,
              Key: { eventCode, participantName },
            },
          },
          {
            Delete: {
              TableName: this.tables.weights,
              Key: { eventCode, participantName },
            },
          },
        ],
      })
    );
  }

  async listWeights(eventCode) {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.weights,
        KeyConditionExpression: "eventCode = :eventCode",
        ExpressionAttributeValues: {
          ":eventCode": eventCode,
        },
      })
    );
    return (res.Items || []).map(mapWeight);
  }

  // --- User methods ---

  async createUser(user) {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.users,
        Item: user,
        ConditionExpression: "attribute_not_exists(userId)",
      })
    );
  }

  async getUserById(userId) {
    const res = await this.doc.send(
      new GetCommand({
        TableName: this.tables.users,
        Key: { userId },
      })
    );
    return res.Item || null;
  }

  async getUserByEmail(email) {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.users,
        IndexName: "email-index",
        KeyConditionExpression: "email = :email",
        ExpressionAttributeValues: { ":email": email },
      })
    );
    return res.Items?.[0] || null;
  }

  async updateUser(userId, updates) {
    const allowedKeys = ["displayName", "passwordHash", "updatedAt"];
    const filtered = Object.entries(updates).filter(([k]) => allowedKeys.includes(k));
    if (filtered.length === 0) return this.getUserById(userId);

    const expr = filtered.map(([,], i) => `#k${i} = :v${i}`).join(", ");
    const names = Object.fromEntries(filtered.map(([k], i) => [`#k${i}`, k]));
    const values = Object.fromEntries(filtered.map(([, v], i) => [`:v${i}`, v]));

    try {
      const res = await this.doc.send(
        new UpdateCommand({
          TableName: this.tables.users,
          Key: { userId },
          UpdateExpression: `SET ${expr}`,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ConditionExpression: "attribute_exists(userId)",
          ReturnValues: "ALL_NEW",
        })
      );
      return res.Attributes || null;
    } catch (err) {
      if (isConditionalCheckFailed(err)) return null;
      throw err;
    }
  }

  // --- UserEvent methods ---

  async createUserEvent({ userId, eventCode, role }) {
    await this.doc.send(
      new PutCommand({
        TableName: this.tables.userEvents,
        Item: {
          userId,
          eventCode,
          role,
          joinedAt: new Date().toISOString(),
        },
      })
    );
  }

  async listUserEvents(userId) {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.userEvents,
        KeyConditionExpression: "userId = :userId",
        ExpressionAttributeValues: { ":userId": userId },
      })
    );
    return res.Items || [];
  }

  async listEventUsers(eventCode) {
    const res = await this.doc.send(
      new QueryCommand({
        TableName: this.tables.userEvents,
        IndexName: "eventCode-index",
        KeyConditionExpression: "eventCode = :eventCode",
        ExpressionAttributeValues: { ":eventCode": eventCode },
      })
    );
    return res.Items || [];
  }

  async upsertWeights(eventCode, weights) {
    await Promise.all(
      weights.map((item) =>
        this.doc.send(
          new PutCommand({
            TableName: this.tables.weights,
            Item: {
              eventCode,
              participantName: item.participantName,
              weight: item.weight,
              included: item.included,
            },
          })
        )
      )
    );
  }
}

export function createDefaultSchedulerStore() {
  return new DynamoSchedulerStore();
}
