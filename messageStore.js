const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');
const path = require('path');

// Ensure directories exist
const FILES_DIR = path.join(__dirname, 'files');
if (!fs.existsSync(FILES_DIR)) {
  fs.mkdirSync(FILES_DIR, { recursive: true });
}

// Initialize database
const DB_PATH = path.join(__dirname, 'chat.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Error opening database:', err.message);
  } else {
    console.log('Connected to the chat database');
    
    // Create messages table if not exists
    db.run(`CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      roomId TEXT NOT NULL,
      userId TEXT NOT NULL,
      nickname TEXT,
      timestamp INTEGER NOT NULL,
      messageType TEXT NOT NULL,
      content TEXT NOT NULL,
      fileId TEXT
    )`, (err) => {
      if (err) {
        console.error('Error creating messages table:', err.message);
      } else {
        console.log('Messages table ready');
      }
    });
    
    // Create files table if not exists
    db.run(`CREATE TABLE IF NOT EXISTS files (
      id TEXT PRIMARY KEY,
      roomId TEXT NOT NULL,
      userId TEXT NOT NULL,
      filename TEXT NOT NULL,
      filepath TEXT NOT NULL,
      filesize INTEGER NOT NULL,
      filetype TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )`, (err) => {
      if (err) {
        console.error('Error creating files table:', err.message);
      } else {
        console.log('Files table ready');
      }
    });
  }
});

/**
 * Store a text message in the database
 * @param {string} roomId - The room ID
 * @param {string} userId - The user ID
 * @param {string} nickname - The user's nickname
 * @param {string} content - The message content
 * @returns {Promise<number>} - The message ID
 */
function storeMessage(roomId, userId, nickname, content) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    const stmt = db.prepare(
      'INSERT INTO messages (roomId, userId, nickname, timestamp, messageType, content) VALUES (?, ?, ?, ?, ?, ?)'
    );
    
    stmt.run(roomId, userId, nickname, timestamp, 'text', content, function(err) {
      if (err) {
        console.error('Error storing message:', err);
        reject(err);
      } else {
        resolve(this.lastID);
      }
    });
    
    stmt.finalize();
  });
}

/**
 * Store a file and its metadata
 * @param {string} roomId - The room ID
 * @param {string} userId - The user ID
 * @param {string} nickname - The user's nickname
 * @param {object} file - The file object with binary data
 * @param {string} filename - Original filename
 * @param {string} filetype - MIME type
 * @returns {Promise<string>} - The file ID
 */
function storeFile(roomId, userId, nickname, file, filename, filetype) {
  return new Promise((resolve, reject) => {
    const timestamp = Date.now();
    const fileId = `${timestamp}_${Math.random().toString(36).substring(2, 15)}`;
    const fileExt = path.extname(filename);
    const safeFileName = `${fileId}${fileExt}`;
    const filePath = path.join(FILES_DIR, safeFileName);
    
    // Save file to disk
    fs.writeFile(filePath, file, (err) => {
      if (err) {
        console.error('Error saving file:', err);
        reject(err);
        return;
      }
      
      const filesize = Buffer.byteLength(file);
      
      // Store file metadata in database
      const fileStmt = db.prepare(
        'INSERT INTO files (id, roomId, userId, filename, filepath, filesize, filetype, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      
      fileStmt.run(fileId, roomId, userId, filename, safeFileName, filesize, filetype, timestamp, function(err) {
        if (err) {
          console.error('Error storing file metadata:', err);
          reject(err);
          return;
        }
        
        // Create a message referencing the file
        const msgStmt = db.prepare(
          'INSERT INTO messages (roomId, userId, nickname, timestamp, messageType, content, fileId) VALUES (?, ?, ?, ?, ?, ?, ?)'
        );
        
        msgStmt.run(roomId, userId, nickname, timestamp, 'file', filename, fileId, function(err) {
          if (err) {
            console.error('Error creating file message:', err);
            reject(err);
            return;
          }
          
          resolve(fileId);
        });
        
        msgStmt.finalize();
      });
      
      fileStmt.finalize();
    });
  });
}

/**
 * Get messages for a room
 * @param {string} roomId - The room ID
 * @param {number} limit - Maximum number of messages to retrieve
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Array>} - Array of messages
 */
function getMessages(roomId, limit = 100, offset = 0) {
  return new Promise((resolve, reject) => {
    db.all(
      `SELECT m.*, f.filename, f.filepath, f.filesize, f.filetype 
       FROM messages m 
       LEFT JOIN files f ON m.fileId = f.id
       WHERE m.roomId = ? 
       ORDER BY m.timestamp DESC 
       LIMIT ? OFFSET ?`,
      [roomId, limit, offset],
      (err, rows) => {
        if (err) {
          console.error('Error retrieving messages:', err);
          reject(err);
        } else {
          resolve(rows.reverse()); // Return in chronological order
        }
      }
    );
  });
}

/**
 * Get a specific file by ID
 * @param {string} fileId - The file ID
 * @returns {Promise<Object>} - File metadata and content
 */
function getFile(fileId) {
  return new Promise((resolve, reject) => {
    db.get('SELECT * FROM files WHERE id = ?', [fileId], (err, row) => {
      if (err) {
        console.error('Error retrieving file metadata:', err);
        reject(err);
        return;
      }
      
      if (!row) {
        reject(new Error('File not found'));
        return;
      }
      
      const filePath = path.join(FILES_DIR, row.filepath);
      fs.readFile(filePath, (err, data) => {
        if (err) {
          console.error('Error reading file from disk:', err);
          reject(err);
          return;
        }
        
        resolve({
          metadata: row,
          data: data
        });
      });
    });
  });
}

/**
 * Check if message storage is enabled for a room
 * @param {string} roomId - The room ID to check
 * @param {Object} roomPwd - The room password configuration object
 * @returns {boolean} - Whether message storage is enabled
 */
function isStorageEnabledForRoom(roomId, roomPwd) {
  if (!roomId || !roomPwd || !roomPwd[roomId]) {
    return false;
  }
  
  return roomPwd[roomId].storeMessages === true;
}

/**
 * Close the database connection when the application exits
 */
function closeDatabase() {
  return new Promise((resolve, reject) => {
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
        reject(err);
      } else {
        console.log('Database connection closed');
        resolve();
      }
    });
  });
}

process.on('exit', () => {
  db.close();
});

module.exports = {
  storeMessage,
  storeFile,
  getMessages,
  getFile,
  isStorageEnabledForRoom,
  closeDatabase
};
