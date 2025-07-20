import express from "express";
import dotenv from "dotenv";
import { rateLimiter } from "./limliter/rate-limiter";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware to apply rate limiting
app.use(async (req, res, next) => {
  const ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
  if (typeof ip === "string") {
    const allowed = await rateLimiter.slidingWindow(ip);
    console.log("Allowed:", allowed);
    if (!allowed) {
      return res.status(429).send("Too many requests, please try again later.");
    }
  }
  next();
});

// Sample route for testing
app.get("/", (req, res) => {
  res.send("Hello, World!");
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
export default app;
