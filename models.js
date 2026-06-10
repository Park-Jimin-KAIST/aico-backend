const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  name: String,
  picture: String,
  createdAt: { type: Date, default: Date.now }
});

const revealSchema = new mongoose.Schema({
  userId: { type: String, ref: 'User', required: true },
  createdAt: { type: Date, default: Date.now }
});

const evaluationSchema = new mongoose.Schema({
  userId: { type: String, ref: 'User', required: true },
  code: String,
  rating: { type: String, enum: ['UNACCEPTABLE', 'POOR', 'FAIR', 'GOOD', 'EXCELLENT', 'BAD', 'OKAY'], required: true },
  feedback: String,
  createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Reveal = mongoose.model('Reveal', revealSchema);
const Evaluation = mongoose.model('Evaluation', evaluationSchema);

const sessionPageSchema = new mongoose.Schema({
  taskDescription: String,
  assignmentFileName: String,
  cardData: mongoose.Schema.Types.Mixed,
  userCode: String,
  evalFeedback: mongoose.Schema.Types.Mixed,
  codeRevealed: { type: Boolean, default: false },
  completedWithoutReveal: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

const sessionSchema = new mongoose.Schema({
  userId: { type: String, ref: 'User', required: false },
  title: { type: String, required: true },
  pages: { type: [sessionPageSchema], default: [] },
  taskDescription: String,
  assignmentFileName: String,
  cardData: mongoose.Schema.Types.Mixed,
  userCode: String,
  evalFeedback: mongoose.Schema.Types.Mixed,
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

const Session = mongoose.model('Session', sessionSchema);

module.exports = { User, Reveal, Evaluation, Session };
