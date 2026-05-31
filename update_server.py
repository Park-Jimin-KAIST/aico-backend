import os

new_server = """const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");
const { OAuth2Client } = require("google-auth-library");
const { User, Reveal, Evaluation } = require("./models");

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({
  origin: "http://localhost:5173",
  methods: ["GET", "POST"],
  credentials: true
}));
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/aico", {
  useNewUrlParser: true,
  useUnifiedTopology: true
}).then(() => console.log("[MongoDB] Connected"))
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

const chunkingModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  systemInstruction: systemInstructionText,
});

const evalModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash",
  systemInstruction: evaluateInstructionText,
  generationConfig: {
    responseMimeType: "application/json",
  }
});

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
    const prompt = `Assignment: ${taskDescription || "Unknown"}\\n\\nUser Code:\\n${code}`;
    const result = await evalModel.generateContent(prompt);
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

    const result = await chunkingModel.generateContent(parts);
    const responseText = result.response.text();
    
    const parseTag = (tag, text) => {
      const regex = new RegExp(`\\\\[${tag}\\\\]([\\\\s\\\\S]*?)\\\\[\\\\/${tag}\\\\]`, "i");
      const match = text.match(regex);
      return match ? match[1].trim() : "";
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

// Start server
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
"""

with open('src/server_update.py', 'w') as f:
    f.write(f'''
import os
with open('server.js', 'w') as f:
    f.write("""{new_server}""")
print("server.js updated")
''')
