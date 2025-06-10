const express = require("express");
const router = express.Router();
const multer = require("multer");
const path = require("path");
const fs = require("fs").promises;
const schoolYearController = require("../controllers/schoolYearController");

const uploadDir = path.join(__dirname, "../uploads");

const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      await fs.mkdir(uploadDir, { recursive: true });
      cb(null, uploadDir);
    } catch (error) {
      console.error("Error creating upload directory:", error);
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const filename = `${Date.now()}${path.extname(file.originalname)}`;
    cb(null, filename);
  },
});

const fileFilter = (req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === ".csv") {
    cb(null, true);
  } else {
    cb(new Error("Only CSV files are allowed"));
  }
};

const upload = multer({ storage, fileFilter });

router.post("/update", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "CSV file is required." });
    }
    await schoolYearController.updateStudents(req.file.path);
    res.status(200).json({ message: "Students updated successfully." });
  } catch (error) {
    res.status(500).json({ error: "Failed to update students." });
  } finally {
    try {
      if (req.file) {
        await fs.unlink(req.file.path);
      }
    } catch (error) {
      console.error("Error deleting uploaded file:", error);
    }
  }
});

router.post("/change-school-year", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "CSV file is required." });
    }
    await schoolYearController.changeSchoolYear(req.file.path);
    res.status(200).json({ message: "School year changed successfully." });
  } catch (error) {
    res.status(500).json({ error: "Failed to change school year." });
  } finally {
    try {
      if (req.file) {
        await fs.unlink(req.file.path);
      }
    } catch (error) {
      console.error("Error deleting uploaded file:", error);
    }
  }
});

router.get("/current", schoolYearController.getCurrentSchoolYear);
module.exports = router;
