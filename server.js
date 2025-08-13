const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static('public'));

// Serve main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/health', (req, res) => {
    res.json({ 
        status: 'OK', 
        message: 'yt-dlp web app is running',
        timestamp: new Date().toISOString()
    });
});

// Download endpoint
app.post('/api/download', async (req, res) => {
    console.log('Download request received:', req.body);
    
    try {
        const { url, options = {} } = req.body;
        
        if (!url) {
            return res.status(400).json({ error: 'URL is required' });
        }

        // Validate URL format
        try {
            new URL(url);
        } catch {
            return res.status(400).json({ error: 'Invalid URL format' });
        }

        console.log('Processing download for:', url);

        // Build yt-dlp command arguments
        const args = [
            url,
            '--no-playlist',  // Download single video only
            '--max-filesize', '50M',  // Limit to 50MB for free tier
            '--socket-timeout', '30',
            '--retries', '2',
            '-o', '/tmp/%(title).50s.%(ext)s'  // Limit filename length
        ];
        
        // Add options based on frontend selections
        if (options.extractAudio) {
            args.push('-x');
            if (options.audioFormat && options.audioFormat !== 'best') {
                args.push('--audio-format', options.audioFormat);
            }
        }

        // Video quality options
        if (!options.extractAudio && options.videoQuality) {
            switch (options.videoQuality) {
                case 'worst':
                    args.push('-f', 'worst[filesize<50M]');
                    break;
                case '720p':
                    args.push('-f', 'best[height<=720][filesize<50M]');
                    break;
                case '1080p':
                    args.push('-f', 'best[height<=1080][filesize<50M]');
                    break;
                default:
                    args.push('-f', 'best[filesize<50M]');
            }
        }

        // Additional options
        if (options.embedSubs) args.push('--embed-subs');
        if (options.embedThumbnail) args.push('--embed-thumbnail');
        if (options.embedMetadata) args.push('--embed-metadata');

        console.log('Executing command: yt-dlp', args.join(' '));

        // Set response headers for file download
        res.setHeader('Content-Type', 'application/octet-stream');
        
        // Execute yt-dlp
        const ytdlp = spawn('yt-dlp', args, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let errorOutput = '';
        let hasStartedDownload = false;

        ytdlp.stdout.on('data', (data) => {
            console.log('STDOUT:', data.toString());
        });

        ytdlp.stderr.on('data', (data) => {
            const output = data.toString();
            errorOutput += output;
            console.log('STDERR:', output);
            
            // Check if download is starting
            if (output.includes('[download]') && !hasStartedDownload) {
                hasStartedDownload = true;
            }
        });

        ytdlp.on('close', (code) => {
            console.log('yt-dlp process exited with code:', code);
            
            if (code === 0) {
                // Find and send the downloaded file
                fs.readdir('/tmp', (err, files) => {
                    if (err) {
                        console.error('Error reading temp directory:', err);
                        return res.status(500).json({ error: 'Could not access downloads' });
                    }

                    // Filter for video/audio files
                    const mediaFiles = files.filter(file => {
                        const ext = path.extname(file).toLowerCase();
                        return ['.mp4', '.webm', '.mp3', '.m4a', '.wav', '.flac'].includes(ext);
                    });

                    if (mediaFiles.length === 0) {
                        return res.status(404).json({ 
                            error: 'No media file found after download',
                            debug: files.slice(0, 10) // Show first 10 files for debugging
                        });
                    }

                    // Get the most recent file
                    let latestFile = mediaFiles[0];
                    let latestTime = 0;
                    
                    mediaFiles.forEach(file => {
                        const stats = fs.statSync(path.join('/tmp', file));
                        if (stats.mtime.getTime() > latestTime) {
                            latestTime = stats.mtime.getTime();
                            latestFile = file;
                        }
                    });

                    const filePath = path.join('/tmp', latestFile);
                    console.log('Sending file:', filePath);

                    // Send file as download
                    res.download(filePath, latestFile, (downloadErr) => {
                        if (downloadErr) {
                            console.error('Error sending file:', downloadErr);
                            if (!res.headersSent) {
                                res.status(500).json({ error: 'Error sending file' });
                            }
                        }
                        
                        // Clean up
                        fs.unlink(filePath, (unlinkErr) => {
                            if (unlinkErr) console.error('Error cleaning up file:', unlinkErr);
                        });
                    });
                });
            } else {
                console.error('Download failed with code:', code);
                console.error('Error output:', errorOutput);
                
                let errorMessage = 'Download failed';
                if (errorOutput.includes('File is too large')) {
                    errorMessage = 'File too large (max 50MB on free tier)';
                } else if (errorOutput.includes('Video unavailable')) {
                    errorMessage = 'Video is unavailable or private';
                } else if (errorOutput.includes('Unsupported URL')) {
                    errorMessage = 'Unsupported website or URL format';
                }
                
                res.status(500).json({ 
                    error: errorMessage,
                    details: errorOutput.slice(-500) // Last 500 chars for debugging
                });
            }
        });

        // Timeout after 5 minutes
        setTimeout(() => {
            if (!res.headersSent) {
                ytdlp.kill('SIGTERM');
                res.status(408).json({ 
                    error: 'Download timeout (5 minutes max)',
                    tip: 'Try a shorter video or lower quality'
                });
            }
        }, 300000);

    } catch (error) {
        console.error('Server error:', error);
        res.status(500).json({ 
            error: 'Internal server error', 
            details: error.message 
        });
    }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Server running on port ${PORT}`);
    console.log(`📁 Serving static files from: ${path.join(__dirname, 'public')}`);
    console.log(`🌐 Health check: http://localhost:${PORT}/health`);
});
