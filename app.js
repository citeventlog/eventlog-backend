const express = require("express");
const cors = require("cors");
const http = require("http");
const socketIo = require("socket.io");
require("dotenv").config();

const app = express();
const server = http.createServer(app);

const io = socketIo(server, {
  cors: {
    origin: process.env.CLIENT_URL || "http://localhost:3000",
    methods: ["GET", "POST"],
    credentials: true,
  },
});

app.use(cors());
app.use(express.json());

app.set("io", io);

app.use((req, res, next) => {
  req.io = io;
  next();
});

const authRoutes = require("./routes/authRoute");
const departmentRoutes = require("./routes/departmentRoute");
const userRoutes = require("./routes/userRoute");
const eventRoutes = require("./routes/eventRoutes");
const blockRoutes = require("./routes/blockRoutes");
const adminRoutes = require("./routes/adminRoutes");
const courseRoutes = require("./routes/courseRoutes");
const roleRoutes = require("./routes/roleRoutes");
const yearLevelRoutes = require("./routes/yearLevelRoutes");
const eventNameRoutes = require("./routes/eventNameRoutes");
const attendanceRoutes = require("./routes/attendanceRoutes");
const schoolYearRoutes = require("./routes/schoolYearRoutes");

app.use(`/api/auth`, authRoutes);
app.use(`/api/departments`, departmentRoutes);
app.use(`/api/users/`, userRoutes);
app.use(`/api/events/`, eventRoutes);
app.use(`/api/blocks/`, blockRoutes);
app.use(`/api/admins`, adminRoutes);
app.use(`/api/courses`, courseRoutes);
app.use(`/api/roles`, roleRoutes);
app.use(`/api/year-level`, yearLevelRoutes);
app.use(`/api/event-names`, eventNameRoutes);
app.use(`/api/attendance`, attendanceRoutes);
app.use(`/api/school-years`, schoolYearRoutes);

app.get("/", (req, res) => {
  res.send("API is running...");
});

io.on("connection", (socket) => {
  socket.on("join-room", (room) => {
    socket.join(room);
    socket.emit("room-joined", {
      room,
      message: `Successfully joined ${room}`,
    });
  });

  socket.on("leave-room", (room) => {
    socket.leave(room);
  });

  socket.on("test-connection", () => {
    socket.emit("test-response", {
      message: "Connection working!",
      timestamp: new Date(),
    });
  });

  socket.on("attendance-update", (data) => {
    socket.to(`event-${data.eventId}`).emit("attendance-updated", data);
  });

  socket.on("event-update", (data) => {
    io.emit("event-updated", data);
  });

  socket.on("user-status-update", (data) => {
    socket
      .to(`department-${data.departmentId}`)
      .emit("user-status-updated", data);
  });

  socket.on("send-notification", (data) => {
    if (data.userId) {
      socket.to(data.userId).emit("notification", data);
    } else if (data.room) {
      socket.to(data.room).emit("notification", data);
    }
  });

  socket.on("disconnect", (reason) => {});
});

const emitUpdate = (event, data, room = null) => {
  if (room) {
    io.to(room).emit(event, data);
  } else {
    io.emit(event, data);
  }
};

global.emitUpdate = emitUpdate;

module.exports = { app, server, io };
