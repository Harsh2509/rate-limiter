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

      // Initialize new window with first request
      if (reqCount === null) {
        await this.redisClient.SET(key, 1, {
          expiration: { type: "EX", value: this.windowMs },
        });
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

  async slidingLogs(ip: string): Promise<boolean> {
    const currentTime = Date.now();
    const key = `sliding:${ip}`;

    try {
      // Remove old timestamps outside the sliding window
      await this.redisClient.zRemRangeByScore(
        key,
        0,
        currentTime - this.windowMs
      );

      // Get current count of requests in the sliding window
      const requestCount = await this.redisClient.zCard(key);

      // Check if rate limit would be exceeded
      if (requestCount >= this.maxRequests) {
        console.log(`Rate limit exceeded for IP: ${ip}`);
        return false; // Rate limit exceeded
      }

      // Add current request timestamp to sorted set
      await this.redisClient.zAdd(key, {
        score: currentTime,
        value: currentTime.toString(),
      });

      // Set expiration for cleanup - key expires after window + buffer time
      await this.redisClient.expire(key, Math.ceil(this.windowMs / 1000) + 60);
      return true; // Request allowed
    } catch (err) {
      console.error("Error accessing Redis:", err);
      return false; // Fail closed - deny request on Redis error
    }
  }

  async leakyBucket(ip: string): Promise<boolean> {
    const currentTime = Date.now();
    const key = `leaky:${ip}`;

    try {
      // Get the last request time and bucket fill level
      const [lastRequest, bucketLevel] = await this.redisClient.hmGet(key, [
        "lastRequest",
        "bucketLevel",
      ]);

      const lastRequestTime = lastRequest ? parseInt(lastRequest) : 0;
      const currentBucketLevel = bucketLevel ? parseInt(bucketLevel) : 0;

      /**
       * Leaky bucket calculations you should consider:
       *
       * Leak Rate: How much time for each request to leak out of the bucket.
       * Leak Rate = Time of each window / maximum allowed requests
       * Example: If window is 10 seconds and max requests is 5, then leak rate is 2 seconds per request.
       * This means every 2 seconds, one request can leak out of the bucket.
       *
       * Leak amount: How many requests can leak out based on the elapsed time since the last request.
       * leakedAmount = elapsed / leakRate;
       */
      const elapsed = currentTime - lastRequestTime;
      const leakedAmount = Math.floor(
        elapsed / (this.windowMs / this.maxRequests)
      );
      const newBucketLevel = Math.max(0, currentBucketLevel - leakedAmount);

      // Check if we can allow the request
      if (newBucketLevel >= this.maxRequests) {
        console.log(`Rate limit exceeded for IP: ${ip}`);
        return false; // Rate limit exceeded
      }

      // Update the bucket level and last request time
      await this.redisClient.hSet(key, {
        lastRequest: currentTime.toString(),
        bucketLevel: (newBucketLevel + 1).toString(),
      });

      // Set expiration for cleanup
      await this.redisClient.expire(key, Math.ceil(this.windowMs / 1000) + 60);
      return true; // Request allowed
    } catch (err) {
      console.error("Error accessing Redis:", err);
      return false; // Fail closed - deny request on Redis error
    }
  }
}

export const rateLimiter = new RateLimiter(5, 10000);
