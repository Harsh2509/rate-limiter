import { RedisClient } from "../services/redis-client";

class RateLimiter {
  private redisClient;

  constructor(private maxRequests: number, private windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.redisClient = RedisClient.getInstance().getClient();
  }

  async fixedWindow(ip: string): Promise<boolean> {
    const currentTime = Date.now();
    // Calculate window start time for fixed window algorithm
    const windowStart = Math.floor(currentTime / this.windowMs) * this.windowMs;
    const key = `${ip}:${windowStart}`;

    try {
      const reqCount = await this.redisClient.GET(key);
      console.log(`Request count for ${key}:`, reqCount);

      // Initialize new window with first request
      if (reqCount === null) {
        await this.redisClient.SET(key, 1, {
          expiration: { type: "EX", value: this.windowMs },
        });
        console.log(`Setting new key ${key} with value 1`);
      }

      // Check if rate limit exceeded
      if (reqCount && parseInt(reqCount) >= this.maxRequests) {
        console.log(`Rate limit exceeded for IP: ${ip}`);
        return false; // Rate limit exceeded
      }

      // Increment request count for this window
      await this.redisClient.INCR(key);
      return true; // Request allowed
    } catch (err) {
      console.error("Error accessing Redis:", err);
      return false; // Fail closed - deny request on Redis error
    }
  }
}

export const rateLimiter = new RateLimiter(5, 10000);
