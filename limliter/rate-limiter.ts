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

  async slidingWindow(ip: string): Promise<boolean> {
    // Implementation for sliding window algorithm
    const currentTime = Date.now();
    const currentWindow = Math.floor(currentTime / this.windowMs);
    const key = `${ip}:${currentWindow}`;
    const requestCount = await this.redisClient.get(key);
    const parsedCount = requestCount ? parseInt(requestCount) : 0;
    if (parsedCount >= this.maxRequests) {
      return false; // Rate limit exceeded
    }
    // Get the last window count
    const lastWindowCount = await this.redisClient.get(
      `${ip}:${currentWindow - 1}`
    );
    const parsedLastCount = lastWindowCount ? parseInt(lastWindowCount) : 0;

    // elapsed time percentage
    const elapsedTime = (currentTime % this.windowMs) / this.windowMs;

    // last window weighted count + current window count
    const weightedCount = parsedLastCount * (1 - elapsedTime) + parsedCount;

    if (weightedCount >= this.maxRequests) {
      console.log(`Rate limit exceeded for IP: ${ip}`);
      return false; // Rate limit exceeded
    }
    // Increment the request count for the current window
    await this.redisClient.set(key, parsedCount + 1, {
      expiration: { type: "EX", value: this.windowMs },
    });
    return true; // Request allowed
  }

  async tokenBucket(ip: string): Promise<boolean> {
    const currentTime = Date.now();
    const key = `token:${ip}`;

    try {
      // Get the current token count and last refill time
      const [tokenCount, lastRefill] = await this.redisClient.hmGet(key, [
        "tokenCount",
        "lastRefill",
      ]);
      const currentTokenCount = tokenCount
        ? parseInt(tokenCount)
        : this.maxRequests;
      const lastRefillTime = lastRefill ? parseInt(lastRefill) : 0;
      const elapsed = currentTime - lastRefillTime;

      // Calculate if we need to refill tokens based on elapsed time
      if (elapsed >= this.windowMs) {
        const newTokenCount = this.maxRequests - 1; // Refill tokens using one for the current request
        await this.redisClient.hSet(key, {
          tokenCount: newTokenCount.toString(),
          lastRefill: currentTime.toString(),
        });
        return true; // Request allowed after refill
      }

      if (currentTokenCount <= 0) {
        console.log(`Rate limit exceeded for IP: ${ip}`);
        return false; // Rate limit exceeded
      }

      // Decrement token count for the current request
      await this.redisClient.hSet(key, {
        tokenCount: (currentTokenCount - 1).toString(),
        lastRefill: lastRefillTime.toString(),
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
