const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { OAuth2Client } = require("google-auth-library");
const { User, Reveal, Evaluation, Session } = require("./models");

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
const allowedOrigins = [
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:5175",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
  "http://127.0.0.1:5175"
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true
}));
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/aico")
  .then(() => console.log("[MongoDB] Connected"))
  .catch(err => console.error("[MongoDB] Connection Error:", err));

// Google Auth Client
const oAuth2Client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || "dummy-client-id");

// Initialize Gemini
if (!process.env.GEMINI_API_KEY) {
  console.error("FATAL ERROR: GEMINI_API_KEY environment variable is not defined.");
  process.exit(1);
}
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Load custom prompts
const chunkingPromptPath = path.join(__dirname, "chunking_prompt.txt");
const systemInstructionText = fs.readFileSync(chunkingPromptPath, "utf-8");
const evaluatePromptPath = path.join(__dirname, "evaluate_prompt.txt");
const evaluateInstructionText = fs.readFileSync(evaluatePromptPath, "utf-8");

// Helper for Gemini content generation with model fallbacks
async function generateContentWithFallback({ parts, systemInstruction, responseMimeType = null }) {
  // Ordered list of models to try based on testing results
  const modelsToTry = [
    "gemini-2.5-flash",
    "gemini-flash-latest",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash"
  ];
  
  let lastError = null;
  for (const model of modelsToTry) {
    try {
      console.log(`[Gemini API] Attempting generateContent with model: ${model}`);
      const modelInstance = genAI.getGenerativeModel({
        model: model,
        systemInstruction: systemInstruction,
        ...(responseMimeType ? { generationConfig: { responseMimeType } } : {})
      });
      const result = await modelInstance.generateContent(parts);
      console.log(`[Gemini API] Success with model: ${model}`);
      return result;
    } catch (err) {
      console.warn(`[Gemini API] Failed with model ${model}:`, err.message || err);
      lastError = err;
    }
  }
  throw lastError;
}

// Auth Endpoint
app.post("/api/auth/google", async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: "Missing credential" });
  
  try {
    let payload;
    if (process.env.GOOGLE_CLIENT_ID) {
      const ticket = await oAuth2Client.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } else {
      // Decode fallback for testing without client ID
      payload = JSON.parse(Buffer.from(credential.split('.')[1], 'base64').toString());
    }

    let user = await User.findOne({ email: payload.email });
    if (!user) {
      user = new User({ email: payload.email, name: payload.name, picture: payload.picture });
      await user.save();
    }
    res.json({ userId: user._id, name: user.name, picture: user.picture });
  } catch (error) {
    console.error("[Auth] Error:", error);
    res.status(500).json({ error: "Auth failed" });
  }
});

// Reveal Endpoint
app.post("/api/reveal", async (req, res) => {
  const { userId } = req.body;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  try {
    await new Reveal({ userId }).save();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to record reveal" });
  }
});

// Evaluate Endpoint
app.post("/api/evaluate", async (req, res) => {
  const { userId, code, taskDescription } = req.body;
  if (!userId) return res.status(401).json({ error: "Unauthorized" });
  if (!code) return res.status(400).json({ error: "No code provided" });

  try {
    const prompt = `Assignment: ${taskDescription || "Unknown"}\n\nUser Code:\n${code}`;
    const result = await generateContentWithFallback({
      parts: [prompt],
      systemInstruction: evaluateInstructionText,
      responseMimeType: "application/json"
    });
    const data = JSON.parse(result.response.text());
    
    // Validate rating
    const validRatings = ['BAD', 'OKAY', 'GOOD'];
    const rating = validRatings.includes(data.rating?.toUpperCase()) ? data.rating.toUpperCase() : 'OKAY';
    
    const evaluation = new Evaluation({
      userId,
      code,
      rating,
      feedback: data.feedback || "Code evaluated."
    });
    await evaluation.save();

    res.json(data);
  } catch (err) {
    console.error("[Evaluate] Error:", err);
    res.status(500).json({ error: "Evaluation failed" });
  }
});

// Generate Chunking Endpoint (from original)
app.post("/api/generate", async (req, res) => {
  const { prompt, file } = req.body;
  if ((!prompt || typeof prompt !== "string") && !file) {
    return res.status(400).json({ error: "A valid prompt or file is required." });
  }
  try {
    console.log(`[Gemini API] Request received. Has prompt: ${!!prompt}, Has file: ${!!file}`);
    const parts = [];
    if (prompt) parts.push({ text: prompt });
    else parts.push({ text: "Please analyze this file." });

    if (file && file.data && file.mimeType) {
      parts.push({ inlineData: { data: file.data, mimeType: file.mimeType } });
    }

    const result = await generateContentWithFallback({
      parts: parts,
      systemInstruction: systemInstructionText
    });
    const responseText = result.response.text();
    
    const parseTag = (tag, text) => {
      const regex = new RegExp(`\\[${tag}\\]([\\s\\S]*?)\\[\\/${tag}\\]`, "i");
      const match = text.match(regex);
      if (!match) return "";
      return match[1].trim().replace(/\\n/g, "\n");
    };

    const data = {
      description: parseTag("description", responseText) || "No description provided.",
      arguments: parseTag("arguments", responseText) || "None",
      returnValues: parseTag("return", responseText) || "None",
      todo: parseTag("todo", responseText) || "No steps provided.",
      tips: parseTag("tips", responseText) || "No tips provided.",
      code: parseTag("code", responseText) || "// No code generated."
    };
    res.json(data);
  } catch (error) {
    console.error("[Gemini API] Error generating content:", error);
    res.status(500).json({ error: "Failed to generate content via Gemini API." });
  }
});

// Stats Endpoint
app.get("/api/stats", async (req, res) => {
  const { userId, range } = req.query; // W, M, Y
  if (!userId) return res.status(401).json({ error: "Unauthorized" });

  try {
    let dateLimit = new Date();
    if (range === 'W') dateLimit.setDate(dateLimit.getDate() - 7);
    else if (range === 'M') dateLimit.setMonth(dateLimit.getMonth() - 1);
    else if (range === 'Y') dateLimit.setFullYear(dateLimit.getFullYear() - 1);
    else dateLimit.setDate(dateLimit.getDate() - 7);

    // Group reveals
    const reveals = await Reveal.find({ userId, createdAt: { $gte: dateLimit } });
    
    // Group evaluations for SCORE_RATINGS
    const evaluations = await Evaluation.find({ userId, createdAt: { $gte: dateLimit } });
    
    const scoreRatings = { red: 0, yellow: 0, green: 0 };
    evaluations.forEach(ev => {
      if (ev.rating === 'BAD') scoreRatings.red++;
      else if (ev.rating === 'OKAY') scoreRatings.yellow++;
      else if (ev.rating === 'GOOD') scoreRatings.green++;
    });

    // Formatting reveal history
    let history = [];
    if (range === 'W') {
      const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      let counts = [0,0,0,0,0,0,0];
      reveals.forEach(r => counts[r.createdAt.getDay()]++);
      // Rotate array so today is last
      const today = new Date().getDay();
      for (let i = 1; i <= 7; i++) {
        const d = (today + i) % 7;
        history.push({ label: days[d], value: counts[d] });
      }
    } else if (range === 'M') {
      let counts = [0,0,0,0];
      reveals.forEach(r => {
        const diffDays = Math.floor((new Date() - r.createdAt) / (1000 * 60 * 60 * 24));
        const weekIdx = Math.floor(diffDays / 7);
        if(weekIdx < 4) counts[3 - weekIdx]++;
      });
      history = [{label:"W1", value:counts[0]}, {label:"W2", value:counts[1]}, {label:"W3", value:counts[2]}, {label:"W4", value:counts[3]}];
    } else if (range === 'Y') {
      const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      let counts = new Array(12).fill(0);
      reveals.forEach(r => counts[r.createdAt.getMonth()]++);
      const currentMonth = new Date().getMonth();
      for (let i = 1; i <= 12; i++) {
        const m = (currentMonth + i) % 12;
        history.push({ label: months[m], value: counts[m] });
      }
    }

    res.json({
      totalReveals: reveals.length,
      scoreRatings,
      history
    });
  } catch (err) {
    console.error("[Stats] Error:", err);
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

// Session Endpoints

// 1. Get all sessions for a user
app.get("/api/sessions", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  try {
    const sessions = await Session.find({ userId }).sort({ updatedAt: -1 });
    res.json(sessions);
  } catch (err) {
    console.error("[Sessions GET] Error:", err);
    res.status(500).json({ error: "Failed to fetch sessions" });
  }
});

// 2. Create a new session
app.post("/api/sessions", async (req, res) => {
  const { userId, title, taskDescription, assignmentFileName, cardData, userCode, evalFeedback, pages } = req.body;
  if (!title) return res.status(400).json({ error: "Missing title" });
  try {
    const session = new Session({
      userId: userId || null,
      title,
      pages: pages || [],
      taskDescription,
      assignmentFileName,
      cardData,
      userCode,
      evalFeedback
    });
    await session.save();
    res.json(session);
  } catch (err) {
    console.error("[Sessions POST] Error:", err);
    res.status(500).json({ error: "Failed to create session" });
  }
});

// 3. Update an existing session
app.put("/api/sessions/:id", async (req, res) => {
  const { id } = req.params;
  const { title, taskDescription, assignmentFileName, cardData, userCode, evalFeedback, pages } = req.body;
  try {
    const updated = await Session.findByIdAndUpdate(
      id,
      {
        title,
        pages,
        taskDescription,
        assignmentFileName,
        cardData,
        userCode,
        evalFeedback,
        updatedAt: Date.now()
      },
      { new: true }
    );
    if (!updated) return res.status(404).json({ error: "Session not found" });
    res.json(updated);
  } catch (err) {
    console.error("[Sessions PUT] Error:", err);
    res.status(500).json({ error: "Failed to update session" });
  }
});

// 4. Delete a single session
app.delete("/api/sessions/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const deleted = await Session.findByIdAndDelete(id);
    if (!deleted) return res.status(404).json({ error: "Session not found" });
    res.json({ success: true });
  } catch (err) {
    console.error("[Sessions DELETE] Error:", err);
    res.status(500).json({ error: "Failed to delete session" });
  }
});

// 5. Clear all sessions for a user
app.delete("/api/sessions/clear/all", async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: "Missing userId" });
  try {
    await Session.deleteMany({ userId });
    res.json({ success: true });
  } catch (err) {
    console.error("[Sessions CLEAR] Error:", err);
    res.status(500).json({ error: "Failed to clear sessions" });
  }
});
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
