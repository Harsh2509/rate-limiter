import { createClient } from "redis";

// a singleton Redis client for the application
export class RedisClient {
  private static instance: RedisClient;
  private client;

  private constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || "redis://localhost:6379",
    });

    this.client.on("error", (err) => console.error("Redis Client Error", err));
    this.client.connect();
    this.client.on("connect", () => {
      console.log("Connected to Redis");
    });
  }

  public static getInstance(): RedisClient {
    if (!RedisClient.instance) {
      RedisClient.instance = new RedisClient();
    }
    return RedisClient.instance;
  }

  public getClient() {
    return this.client;
  }
}
