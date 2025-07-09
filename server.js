const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const xml2js = require('xml2js');

const app = express();
const PORT = process.env.PORT || 80;

// CORS configuration for ngrok
app.use(cors({
    origin: [
        'https://43e6-42-200-214-30.ngrok-free.app', 
        'http://localhost:3000', 
        'http://localhost:80',
        'https://boostshop-dev.myshopify.com'
    ],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'ngrok-skip-browser-warning']
}));

app.use(express.json());

// Create uploads directory if it doesn't exist
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir);
}

// Create outputs directory if it doesn't exist  
const outputsDir = path.join(__dirname, 'outputs');
if (!fs.existsSync(outputsDir)) {
    fs.mkdirSync(outputsDir);
}

// Configure multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const imageId = uuidv4();
        const fileName = `${imageId}-${file.originalname}`;
        req.imageId = imageId;
        req.fileName = fileName;
        cb(null, fileName);
    }
});

const upload = multer({ storage });

// In-memory storage for processed results
const processedImages = new Map();
const progressStreams = new Map(); // Store SSE connections
const activeProcesses = new Map(); // Track active child processes for cancellation

// Helper function to broadcast progress to connected SSE clients
function broadcastProgress(imageId, message) {
    const clients = progressStreams.get(imageId) || [];
    if (clients && clients.length > 0) {
        const data = `data: ${JSON.stringify(message)}\n\n`;
        clients.forEach(client => {
            try {
                client.write(data);
            } catch (error) {
                console.error('Error sending SSE message:', error);
            }
        });
        console.log(`📡 Broadcast to ${clients.length} clients:`, message.type);
    }
}

// Helper function to clean up files after processing
function cleanupFiles(imageId, inputPath, outputSvgPath, outputJsonPath, settingsPath) {
    const filesToClean = [inputPath, outputSvgPath, outputJsonPath, settingsPath].filter(Boolean);
    
    setTimeout(() => {
        filesToClean.forEach(filePath => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️  Cleaned up file: ${filePath}`);
                }
            } catch (error) {
                console.error(`❌ Error cleaning up file ${filePath}:`, error);
            }
        });
        console.log(`✨ Cleanup completed for image ${imageId}`);
    }, 10000); // Wait 10 seconds to ensure client received the data
}

// Helper function to cancel processing for an image
function cancelProcessing(imageId, reason = 'Client disconnected') {
    const childProcess = activeProcesses.get(imageId);
    if (childProcess && !childProcess.killed) {
        console.log(`🚫 Cancelling processing for image ${imageId}: ${reason}`);
        
        // Kill the child process
        childProcess.kill('SIGTERM');
        
        // If SIGTERM doesn't work, force kill after 5 seconds
        setTimeout(() => {
            if (!childProcess.killed) {
                console.log(`💀 Force killing process for image ${imageId}`);
                childProcess.kill('SIGKILL');
            }
        }, 5000);
        
        // Clean up
        activeProcesses.delete(imageId);
        
        // Clean up any files that might have been created before cancellation
        setTimeout(() => {
            try {
                // Clean up input file if it exists
                const uploadFiles = fs.readdirSync(uploadsDir).filter(file => file.startsWith(imageId));
                uploadFiles.forEach(file => {
                    const filePath = path.join(uploadsDir, file);
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️  Cleaned up upload file: ${filePath}`);
                    } catch (err) {
                        console.error(`❌ Error cleaning upload file: ${err}`);
                    }
                });
                
                // Clean up any output files that might have been created
                const outputFiles = fs.readdirSync(outputsDir).filter(file => file.startsWith(imageId));
                outputFiles.forEach(file => {
                    const filePath = path.join(outputsDir, file);
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`🗑️  Cleaned up output file: ${filePath}`);
                    } catch (err) {
                        console.error(`❌ Error cleaning output file: ${err}`);
                    }
                });
                
                // Clean up settings files
                const settingsFiles = fs.readdirSync(outputsDir).filter(file => 
                    file.startsWith('settings-') && file.endsWith('.json')
                );
                settingsFiles.forEach(settingsFile => {
                    const settingsPath = path.join(outputsDir, settingsFile);
                    try {
                        fs.unlinkSync(settingsPath);
                        console.log(`🗑️  Cleaned up settings file: ${settingsPath}`);
                    } catch (err) {
                        console.error(`❌ Error cleaning settings file: ${err}`);
                    }
                });
                
                console.log(`✨ Cancellation cleanup completed for image ${imageId}`);
            } catch (error) {
                console.error(`❌ Error during cancellation cleanup: ${error}`);
            }
        }, 1000); // Short delay to ensure process is fully stopped
        
        // Store cancellation result
        const cancelResult = {
            imageId,
            processedAt: new Date().toISOString(),
            success: false,
            cancelled: true,
            reason: reason
        };
        processedImages.set(imageId, cancelResult);
        
        // Broadcast cancellation to any remaining clients
        broadcastProgress(imageId, {
            type: 'cancelled',
            message: `Processing cancelled: ${reason}`,
            timestamp: new Date().toISOString()
        });
        
        return true;
    }
    return false;
}

// Parse SVG and extract regions for progressive streaming
async function parseSVGAndStreamRegions(imageId, svgPath, jsonPath) {
    try {
        console.log(`🎨 Starting progressive region streaming for ${imageId}`);
        
        // Read SVG file
        const svgContent = await fs.promises.readFile(svgPath, 'utf8');
        const paletteData = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
        
        // Parse SVG using regex for better performance (xml2js is slow for large files)
        const regions = [];
        
        // Extract path elements with their labels
        const pathRegex = /<path data-facetId="(\d+)" d="([^"]+)" style="fill: rgb\(([^)]+)\)[^>]*>/g;
        const labelRegex = /<g class="label" transform="translate\(([^)]+)\)"[^>]*>[\s\S]*?<text[^>]*>(\d+)<\/text>/g;
        
        let pathMatch;
        while ((pathMatch = pathRegex.exec(svgContent)) !== null) {
            const [, facetId, pathData, rgbColor] = pathMatch;
            regions.push({
                facetId: parseInt(facetId),
                pathData,
                color: rgbColor.split(',').map(c => parseInt(c.trim())),
                pathElement: pathMatch[0]
            });
        }
        
        // Extract labels
        const labels = new Map();
        let labelMatch;
        while ((labelMatch = labelRegex.exec(svgContent)) !== null) {
            const [, transform, number] = labelMatch;
            const coords = transform.split(',').map(c => parseFloat(c));
            if (coords.length >= 2) {
                labels.set(parseInt(number), {
                    x: coords[0],
                    y: coords[1],
                    number: parseInt(number)
                });
            }
        }
        
        console.log(`🎨 Parsed ${regions.length} regions from SVG`);
        
        // Sort regions by size (smallest first for better visual effect)
        regions.sort((a, b) => a.pathData.length - b.pathData.length);
        
        // Stream regions progressively
        let streamedCount = 0;
        const totalRegions = regions.length;
        const streamInterval = 100; // Stream every 100ms
        
        broadcastProgress(imageId, {
            type: 'regions_start',
            totalRegions,
            message: `Starting progressive painting of ${totalRegions} regions...`,
            timestamp: new Date().toISOString()
        });
        
        const streamRegions = () => {
            if (streamedCount >= totalRegions) {
                // Finished streaming all regions
                broadcastProgress(imageId, {
                    type: 'regions_complete',
                    streamedCount: totalRegions,
                    message: 'All regions painted!',
                    timestamp: new Date().toISOString()
                });
                return;
            }
            
            // Stream next batch (1-3 regions at a time for visual effect)
            const batchSize = Math.min(3, totalRegions - streamedCount);
            const batch = [];
            
            for (let i = 0; i < batchSize; i++) {
                if (streamedCount < totalRegions) {
                    const region = regions[streamedCount];
                    const label = labels.get(region.facetId) || labels.get(streamedCount) || 
                                 Array.from(labels.values())[streamedCount % labels.size];
                    
                    batch.push({
                        facetId: region.facetId,
                        pathData: region.pathData,
                        color: region.color,
                        label: label ? {
                            x: label.x,
                            y: label.y,
                            number: label.number
                        } : null,
                        index: streamedCount
                    });
                    streamedCount++;
                }
            }
            
            // Send batch of regions
            broadcastProgress(imageId, {
                type: 'region_batch',
                regions: batch,
                streamedCount,
                totalRegions,
                progress: Math.round((streamedCount / totalRegions) * 100),
                message: `Painted ${streamedCount}/${totalRegions} regions`,
                timestamp: new Date().toISOString()
            });
            
            // Schedule next batch
            setTimeout(streamRegions, streamInterval);
        };
        
        // Start streaming with a small delay
        setTimeout(streamRegions, 500);
        
    } catch (error) {
        console.error('❌ Error parsing SVG for region streaming:', error);
        broadcastProgress(imageId, {
            type: 'error',
            message: 'Failed to parse SVG for progressive streaming',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
}

// Process image function with live progress streaming
async function processImage(inputPath, outputPath, settings, imageId) {
    return new Promise((resolve, reject) => {
        // Generate settings file path
        const settingsPath = path.join(__dirname, 'outputs', `settings-${Date.now()}.json`);
        
        // Convert simplified settings to full CLI format
        const cliSettings = {
            randomSeed: 50,
            kMeansNrOfClusters: parseInt(settings.numberOfColors) || 16,
            kMeansMinDeltaDifference: 5,
            kMeansClusteringColorSpace: settings.colorSpace || 'RGB',
            kMeansColorRestrictions: [],
            colorAliases: {},
            removeFacetsSmallerThanNrOfPoints: settings.minFacetSize || 50,
            removeFacetsFromLargeToSmall: true,
            maximumNumberOfFacets: settings.maxFacets || 20000,
            nrOfTimesToHalveBorderSegments: 1,
            narrowPixelStripCleanupRuns: 0,
            resizeImageIfTooLarge: true,
            resizeImageWidth: settings.maxWidth || 768,
            resizeImageHeight: settings.maxHeight || 768,
            outputProfiles: [
                {
                    name: "default",
                    svgShowLabels: true,
                    svgFillFacets: true,
                    svgShowBorders: true,
                    svgSizeMultiplier: 2,
                    svgFontSize: 40,
                    svgFontColor: "#333",
                    filetype: "svg"
                }
            ]
        };
        
        // Write settings to file
        fs.writeFileSync(settingsPath, JSON.stringify(cliSettings, null, 2));
        
        const args = [
            path.join(__dirname, 'src-cli', 'main.js'),
            '-i', inputPath,
            '-o', outputPath,
            '-c', settingsPath
        ];
        
        console.log(`🎨 Starting paint-by-numbers processing...`);
        console.log(`📁 Input: ${inputPath}`);
        console.log(`📁 Output: ${outputPath}`);
        console.log(`⚙️  Settings:`, JSON.stringify(settings, null, 2));
        console.log(`🚀 Running: node ${args.join(' ')}`);

        const cli = spawn('node', args, { stdio: ['pipe', 'pipe', 'pipe'] });
        
        // Store the process for potential cancellation
        activeProcesses.set(imageId, cli);
        
        let liveStreamingStarted = false;
        let liveFacetCount = 0;
        let totalFacetsExpected = 0;
        let processWasCancelled = false;
        
        cli.stdout.on('data', (data) => {
            const output = data.toString();
            const lines = output.split('\n');
            
            for (const line of lines) {
                if (line.trim()) {
                    console.log('📊 CLI Output:', line.trim());
                    
                    // Handle live streaming markers
                    if (line.includes('LIVE_STREAMING_START')) {
                        liveStreamingStarted = true;
                        liveFacetCount = 0;
                        
                        // Start live streaming
                        broadcastProgress(imageId, {
                            type: 'live_streaming_start',
                            message: 'Starting live region streaming...'
                        });
                        continue;
                    }
                    
                    if (line.includes('LIVE_STREAMING_END')) {
                        liveStreamingStarted = false;
                        
                        // End live streaming
                        broadcastProgress(imageId, {
                            type: 'live_streaming_complete',
                            totalFacets: liveFacetCount,
                            message: `Live streaming complete! ${liveFacetCount} regions streamed`
                        });
                        continue;
                    }
                    
                    // Handle individual live facets
                    if (liveStreamingStarted && line.startsWith('LIVE_FACET:')) {
                        try {
                            const facetData = JSON.parse(line.substring(11)); // Remove "LIVE_FACET:" prefix
                            liveFacetCount++;
                            
                            // Stream individual facet immediately
                            broadcastProgress(imageId, {
                                type: 'live_facet',
                                facet: facetData,
                                streamedCount: liveFacetCount,
                                message: `Live region ${liveFacetCount}: ${facetData.facetId}`
                            });
                            
                        } catch (error) {
                            console.error('❌ Error parsing live facet data:', error);
                        }
                        continue;
                    }
                    
                    // Handle other CLI output
                    if (line.includes('Running k-means clustering')) {
                        broadcastProgress(imageId, {
                            type: 'stage',
                            stage: 'K-means Clustering',
                            message: 'Running k-means clustering'
                        });
                    } else if (line.includes('Creating facets')) {
                        broadcastProgress(imageId, {
                            type: 'stage', 
                            stage: 'Creating Facets',
                            message: 'Creating facets'
                        });
                    } else if (line.includes('Reducing facets')) {
                        broadcastProgress(imageId, {
                            type: 'stage',
                            stage: 'Reducing Facets', 
                            message: 'Reducing facets'
                        });
                    } else if (line.includes('Build border paths')) {
                        broadcastProgress(imageId, {
                            type: 'stage',
                            stage: 'Border Paths',
                            message: 'Building border paths'
                        });
                    } else if (line.includes('Build border path segments')) {
                        broadcastProgress(imageId, {
                            type: 'stage',
                            stage: 'Border Segments',
                            message: 'Building border path segments'
                        });
                    } else if (line.includes('Determine label placement')) {
                        broadcastProgress(imageId, {
                            type: 'stage',
                            stage: 'Label Placement',
                            message: 'Determining label placement'
                        });
                    } else if (line.includes('Generating output')) {
                        broadcastProgress(imageId, {
                            type: 'stage',
                            stage: 'Generating Output',
                            message: 'Generating output files'
                        });
                    } else if (line.includes('Finished')) {
                        broadcastProgress(imageId, {
                            type: 'complete',
                            message: 'Processing completed successfully!'
                        });
                    } else {
                        // Generic progress message
                        broadcastProgress(imageId, {
                            type: 'progress',
                            message: line.trim()
                        });
                    }
                }
            }
        });

        cli.stderr.on('data', (data) => {
            const error = data.toString();
            console.error('❌ CLI Error:', error.trim());
            
            // Parse point reallocation messages for progress updates
            if (error.includes('was reallocated to neighbours for facet')) {
                broadcastProgress(imageId, {
                    type: 'pixel_update',
                    message: `Pixel reallocation: ${error.trim()}`
                });
            }
        });

        cli.on('close', (code, signal) => {
            // Clean up the active process tracking
            activeProcesses.delete(imageId);
            
            if (signal === 'SIGTERM' || signal === 'SIGKILL') {
                console.log(`🚫 Process was cancelled with signal: ${signal}`);
                processWasCancelled = true;
                reject(new Error(`Process was cancelled (${signal})`));
                return;
            }
            
            if (code === 0 && !processWasCancelled) {
                console.log('✅ Processing completed successfully!');
                
                // Check if output files exist (CLI adds profile name suffix to SVG)
                const svgBaseName = path.basename(outputPath, '.svg');
                const svgWithProfile = path.join(path.dirname(outputPath), `${svgBaseName}-default.svg`);
                const svgExists = fs.existsSync(svgWithProfile);
                const jsonPath = outputPath.replace('.svg', '.json');
                const jsonExists = fs.existsSync(jsonPath);
                
                console.log('📋 Output files - SVG:', svgExists, 'JSON:', jsonExists);
                console.log('📁 Expected SVG path:', svgWithProfile);
                console.log('📁 Expected JSON path:', jsonPath);
                
                // Always resolve with available files (don't reject if SVG missing)
                const result = {
                    svgPath: svgExists ? svgWithProfile : null,
                    jsonPath: jsonExists ? jsonPath : null,
                    svgExists,
                    jsonExists,
                    settingsPath // Include settings path for cleanup
                };
                
                console.log('🎯 processImage resolving with:', result);
                
                // Send final result broadcast from here too
                broadcastProgress(imageId, {
                    type: 'files_check',
                    svgExists,
                    jsonExists,
                    svgPath: result.svgPath,
                    jsonPath: result.jsonPath,
                    message: `Files check complete - SVG: ${svgExists}, JSON: ${jsonExists}`
                });
                
                resolve(result);
            } else if (!processWasCancelled) {
                console.error('❌ CLI process failed with code:', code);
                reject(new Error(`CLI process failed with code: ${code}`));
            }
        });

        cli.on('error', (error) => {
            console.error('❌ Failed to start CLI process:', error);
            // Clean up the active process tracking
            activeProcesses.delete(imageId);
            reject(error);
        });
    });
}

// OPTIONS endpoint for CORS preflight
app.options('/progress/:imageId', (req, res) => {
    res.writeHead(200, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control, ngrok-skip-browser-warning, Accept',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Max-Age': '86400'
    });
    res.end();
});

// Server-Sent Events endpoint for live progress
app.get('/progress/:imageId', (req, res) => {
    const { imageId } = req.params;
    
    console.log(`📡 SSE request for image ${imageId}:`, {
        headers: req.headers,
        userAgent: req.headers['user-agent'],
        accept: req.headers.accept
    });
    
    // Set SSE headers with ngrok bypass
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control, ngrok-skip-browser-warning',
        'Access-Control-Allow-Methods': 'GET',
        'ngrok-skip-browser-warning': 'true'  // Add this to bypass ngrok warning
    });

    // Add client to the list for this image
    if (!progressStreams.has(imageId)) {
        progressStreams.set(imageId, []);
    }
    progressStreams.get(imageId).push(res);

    console.log(`📡 SSE client connected for image ${imageId}`);

    // Send initial connection message
    res.write(`data: ${JSON.stringify({
        type: 'connected',
        message: 'Connected to progress stream',
        imageId,
        timestamp: new Date().toISOString()
    })}\n\n`);

    // Clean up on client disconnect
    req.on('close', () => {
        console.log(`📡 SSE client disconnected for image ${imageId}`);
        const clients = progressStreams.get(imageId) || [];
        const index = clients.indexOf(res);
        if (index !== -1) {
            clients.splice(index, 1);
        }
        
        // If no more clients connected, cancel the processing
        if (clients.length === 0) {
            console.log(`🚫 No more clients connected for image ${imageId}, cancelling processing`);
            progressStreams.delete(imageId);
            
            // Cancel the processing if it's still active
            cancelProcessing(imageId, 'All clients disconnected');
        }
    });
});

// Upload and process endpoint
app.post('/generated-image', upload.single('image'), async (req, res) => {
    try {
        console.log('Received upload request:', {
            file: req.file?.originalname,
            body: req.body
        });

        if (!req.file) {
            return res.status(400).json({ 
                success: false, 
                error: 'No image file received' 
            });
        }

        const imageId = req.imageId;
        const fileName = req.fileName;
        const imagePath = path.join(uploadsDir, fileName);

        // Parse settings from request
        const settings = {
            numberOfColors: req.body.colors || '16',
            clusterPrecision: 1,
            colorSpace: 'RGB',
            minFacetSize: 50,
            maxFacets: 20000,
            maxWidth: 768,
            maxHeight: 768
        };

        console.log(`Image stored with ID: ${imageId} Settings:`, settings);

        // Immediately return the response with progress stream URL
        res.json({
            success: true,
            imageId,
            imageUrl: `/uploads/${fileName}`,
            progressUrl: `/progress/${imageId}`,
            message: 'Image uploaded successfully. Connect to progress stream for live updates.',
            settings
        });

        // Process the image asynchronously with progress streaming
        const outputSvgPath = path.join(outputsDir, `${imageId}.svg`);
        const outputJsonPath = path.join(outputsDir, `${imageId}.json`);

        try {
            console.log(`🎯 Starting processing for image ${imageId}`);
            const result = await processImage(imagePath, outputSvgPath, settings, imageId);
            
            console.log(`🔍 processImage returned:`, result);
            
            // Use the actual paths returned by processImage
            const svgPath = result.svgPath;
            const jsonPath = result.jsonPath;
            const svgExists = svgPath && fs.existsSync(svgPath);
            const jsonExists = jsonPath && fs.existsSync(jsonPath);

            console.log(`📋 Output files - SVG: ${svgExists}, JSON: ${jsonExists}`);
            console.log(`📁 Actual SVG path: ${svgPath}`);
            console.log(`📁 Actual JSON path: ${jsonPath}`);

            // Construct URLs
            const svgUrl = svgExists ? `/outputs/${path.basename(svgPath)}` : null;
            const jsonUrl = jsonExists ? `/outputs/${path.basename(jsonPath)}` : null;
            
            console.log(`🌐 Constructed URLs - SVG: ${svgUrl}, JSON: ${jsonUrl}`);

            // Store processing result
            const processResult = {
                imageId,
                inputPath: imagePath,
                outputSvgPath: svgPath,
                outputJsonPath: jsonPath,
                settings,
                processedAt: new Date().toISOString(),
                success: true,
                svgUrl: svgUrl,
                jsonUrl: jsonUrl
            };

            console.log(`💾 Storing processResult:`, {
                imageId: processResult.imageId,
                success: processResult.success,
                svgUrl: processResult.svgUrl,
                jsonUrl: processResult.jsonUrl
            });

            processedImages.set(imageId, processResult);

            // Broadcast final result to SSE clients
            console.log(`📡 Broadcasting final result with URLs - SVG: ${processResult.svgUrl}, JSON: ${processResult.jsonUrl}`);
            broadcastProgress(imageId, {
                type: 'result',
                imageId: imageId,
                success: true,
                svgUrl: processResult.svgUrl,
                jsonUrl: processResult.jsonUrl,
                result: processResult,
                timestamp: new Date().toISOString()
            });

            // Clean up files after successful processing
            cleanupFiles(imageId, imagePath, svgPath, jsonPath, result.settingsPath);

        } catch (processingError) {
            console.error(`❌ Processing failed for image ${imageId}:`, processingError.message);
            
            // Check if it was cancelled
            const wasCancelled = processingError.message.includes('cancelled');
            
            // Store failed result
            const processResult = {
                imageId,
                inputPath: imagePath,
                settings,
                processedAt: new Date().toISOString(),
                success: false,
                cancelled: wasCancelled,
                error: processingError.message
            };

            processedImages.set(imageId, processResult);

            // Broadcast error to SSE clients (only if not cancelled - cancellation already broadcasts)
            if (!wasCancelled) {
                broadcastProgress(imageId, {
                    type: 'result_error',
                    error: processingError.message,
                    timestamp: new Date().toISOString()
                });

                // Clean up files after error (but not if cancelled - files might not exist yet)
                setTimeout(() => {
                    try {
                        // Clean up input file
                        if (fs.existsSync(imagePath)) {
                            fs.unlinkSync(imagePath);
                            console.log(`🗑️  Cleaned up input file: ${imagePath}`);
                        }
                        
                        // Clean up any settings file that might have been created
                        const settingsFiles = fs.readdirSync(outputsDir).filter(file => 
                            file.startsWith('settings-') && file.endsWith('.json')
                        );
                        settingsFiles.forEach(settingsFile => {
                            const settingsPath = path.join(outputsDir, settingsFile);
                            try {
                                fs.unlinkSync(settingsPath);
                                console.log(`🗑️  Cleaned up settings file: ${settingsPath}`);
                            } catch (err) {
                                console.error(`❌ Error cleaning settings file: ${err}`);
                            }
                        });
                        
                        console.log(`✨ Error cleanup completed for image ${imageId}`);
                    } catch (error) {
                        console.error(`❌ Error during cleanup: ${error}`);
                    }
                }, 2000); // Shorter delay for error cleanup
            }
        }

    } catch (error) {
        console.error('❌ Upload error:', error);
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error: ' + error.message 
        });
    }
});

// Get processing status endpoint
app.get('/status/:imageId', (req, res) => {
    const { imageId } = req.params;
    const result = processedImages.get(imageId);
    
    if (!result) {
        return res.status(404).json({
            success: false,
            error: 'Image not found'
        });
    }

    res.json({
        success: true,
        result
    });
});

// Cancel processing endpoint
app.post('/cancel/:imageId', (req, res) => {
    const { imageId } = req.params;
    
    const cancelled = cancelProcessing(imageId, 'Manual cancellation requested');
    
    if (cancelled) {
        res.json({
            success: true,
            message: `Processing cancelled for image ${imageId}`
        });
    } else {
        res.status(404).json({
            success: false,
            error: 'No active processing found for this image ID'
        });
    }
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));
app.use('/outputs', express.static(outputsDir));

// Legacy process route (now just returns status)
app.get('/process/:id', (req, res) => {
    const imageId = req.params.id;
    console.log(`🔍 Legacy process route accessed for ID: ${imageId}`);
    
    const result = processedImages.get(imageId);
    
    if (!result) {
        console.log(`❌ Image not found for ID: ${imageId}`);
        console.log(`📊 Available image IDs:`, Array.from(processedImages.keys()));
        return res.status(404).send(`
            <html>
                <body>
                    <h1>Image Not Found</h1>
                    <p>No processing result found for ID: ${imageId}</p>
                    <p>Available IDs: ${Array.from(processedImages.keys()).join(', ')}</p>
                    <a href="/">Back to Home</a>
                </body>
            </html>
        `);
    }

    res.send(`
        <html>
            <body>
                <h1>Processing Status</h1>
                <p><strong>Image ID:</strong> ${imageId}</p>
                <p><strong>Status:</strong> ${result.success ? 'Completed' : 'Failed'}</p>
                <p><strong>Processed At:</strong> ${result.processedAt}</p>
                
                ${result.success ? `
                    <h2>Results:</h2>
                    <p><strong>SVG:</strong> <a href="${result.svgUrl || '#'}" target="_blank">View SVG</a></p>
                    <p><strong>JSON:</strong> <a href="${result.jsonUrl || '#'}" target="_blank">View JSON</a></p>
                ` : `
                    <h2>Error:</h2>
                    <p>${result.error}</p>
                `}
                
                <h2>Settings Used:</h2>
                <pre>${JSON.stringify(result.settings, null, 2)}</pre>
                
                <a href="/">Back to Home</a>
            </body>
        </html>
    `);
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        message: 'Paint by Numbers Generator Server is running',
        timestamp: new Date().toISOString(),
        processedImages: processedImages.size,
        activeProcesses: activeProcesses.size,
        connectedSSEClients: Array.from(progressStreams.entries()).reduce((total, [imageId, clients]) => total + clients.length, 0)
    });
});

// API documentation endpoint
app.get('/api-docs', (req, res) => {
    res.json({
        endpoints: {
            'POST /generated-image': {
                description: 'Upload and process an image',
                parameters: {
                    image: 'Image file (multipart/form-data)',
                    colors: 'Number of colors for paint-by-numbers (optional, default: 24)'
                },
                response: {
                    success: 'boolean',
                    imageId: 'string',
                    imageUrl: 'string',
                    svgUrl: 'string (if successful)',
                    jsonUrl: 'string (if successful)',
                    message: 'string',
                    processingCompleted: 'boolean'
                }
            },
            'GET /progress/:imageId': {
                description: 'Server-Sent Events endpoint for real-time processing progress',
                note: 'Processing is automatically cancelled if all SSE clients disconnect. Files are cleaned up automatically after processing.'
            },
            'GET /status/:imageId': {
                description: 'Get processing status for an image',
                response: {
                    success: 'boolean',
                    result: 'object with processing details (includes cancelled flag)'
                }
            },
            'POST /cancel/:imageId': {
                description: 'Manually cancel processing for an image',
                response: {
                    success: 'boolean',
                    message: 'string'
                }
            },
            'GET /health': {
                description: 'Health check endpoint'
            }
        }
    });
});

// Serve the main page
app.get('/', (req, res) => {
    res.send(`
        <html>
            <head>
                <title>Paint by Numbers Generator Server</title>
                <style>
                    body { font-family: Arial, sans-serif; margin: 40px; }
                    .container { max-width: 800px; margin: 0 auto; }
                    h1 { color: #333; }
                    .endpoint { background: #f5f5f5; padding: 20px; margin: 20px 0; border-radius: 5px; }
                    .status { color: #28a745; font-weight: bold; }
                    pre { background: #f8f9fa; padding: 10px; border-radius: 3px; overflow-x: auto; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🎨 Paint by Numbers Generator Server</h1>
                    <p class="status">Server is running and ready to process images!</p>
                    
                    <h2>📡 API Endpoints</h2>
                    
                    <div class="endpoint">
                        <h3>POST /generated-image</h3>
                        <p>Upload and automatically process an image into paint-by-numbers format</p>
                        <pre>curl -X POST -F "image=@your-image.png" -F "colors=24" ${req.get('host')}/generated-image</pre>
                    </div>
                    
                    <div class="endpoint">
                        <h3>GET /progress/:imageId</h3>
                        <p>Server-Sent Events endpoint for real-time processing progress</p>
                        <p><em>Note: Processing is automatically cancelled if all SSE clients disconnect</em></p>
                    </div>
                    
                    <div class="endpoint">
                        <h3>GET /status/:imageId</h3>
                        <p>Check processing status and get results</p>
                        <pre>curl ${req.get('host')}/status/your-image-id</pre>
                    </div>
                    
                    <div class="endpoint">
                        <h3>POST /cancel/:imageId</h3>
                        <p>Manually cancel processing for an image</p>
                        <pre>curl -X POST ${req.get('host')}/cancel/your-image-id</pre>
                    </div>
                    
                    <div class="endpoint">
                        <h3>GET /health</h3>
                        <p>Server health check</p>
                        <pre>curl ${req.get('host')}/health</pre>
                    </div>

                    <div class="endpoint">
                        <h3>GET /api-docs</h3>
                        <p>Full API documentation</p>
                        <pre>curl ${req.get('host')}/api-docs</pre>
                    </div>
                    
                    <h2>🌐 For External Access</h2>
                    <p>Use ngrok URL: <strong>https://43e6-42-200-214-30.ngrok-free.app</strong></p>
                    
                    <h2>📊 Current Status</h2>
                    <p>Processed Images: <strong>${processedImages.size}</strong></p>
                    <p>Active Processes: <strong>${activeProcesses.size}</strong></p>
                    <p>Connected SSE Clients: <strong>${Array.from(progressStreams.entries()).reduce((total, [imageId, clients]) => total + clients.length, 0)}</strong></p>
                    
                    <h2>🗑️ File Management</h2>
                    <p><em>Files are automatically cleaned up 10 seconds after processing to keep server storage clean.</em></p>
                    
                    <h2>🧪 Test Interface</h2>
                    <p><a href="/test-api.html">Test API Interface</a></p>
                    <p><a href="/original">Original Paint by Numbers App</a></p>
                </div>
            </body>
        </html>
    `);
});

// Serve the original app at /original
app.get('/original', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve static files for everything else (CSS, JS, etc.)
app.use(express.static('.'));

// Periodic cleanup task for orphaned files
setInterval(() => {
    try {
        const now = Date.now();
        const oneHourAgo = now - (60 * 60 * 1000); // 1 hour ago
        
        console.log('🧹 Running periodic cleanup for orphaned files...');
        
        // Clean up old files in uploads directory (older than 1 hour)
        if (fs.existsSync(uploadsDir)) {
            const uploadFiles = fs.readdirSync(uploadsDir);
            for (const file of uploadFiles) {
                const filePath = path.join(uploadsDir, file);
                const stats = fs.statSync(filePath);
                if (stats.mtime.getTime() < oneHourAgo) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`🧹 Periodic cleanup: Removed old upload file ${file}`);
                    } catch (error) {
                        console.error(`❌ Error removing old upload file ${file}:`, error);
                    }
                }
            }
        }
        
        // Clean up old files in outputs directory (older than 1 hour)
        if (fs.existsSync(outputsDir)) {
            const outputFiles = fs.readdirSync(outputsDir);
            for (const file of outputFiles) {
                const filePath = path.join(outputsDir, file);
                const stats = fs.statSync(filePath);
                if (stats.mtime.getTime() < oneHourAgo) {
                    try {
                        fs.unlinkSync(filePath);
                        console.log(`🧹 Periodic cleanup: Removed old output file ${file}`);
                    } catch (error) {
                        console.error(`❌ Error removing old output file ${file}:`, error);
                    }
                }
            }
        }
        
        console.log('🧹 Periodic cleanup completed');
    } catch (error) {
        console.error('❌ Error in periodic cleanup:', error);
    }
}, 60 * 60 * 1000); // Run every hour

app.listen(PORT, () => {
    console.log(`Paint by Numbers Generator Server running on port ${PORT}`);
    console.log(`Access the web interface at: http://localhost:${PORT}`);
    console.log(`API endpoint: POST http://localhost:${PORT}/generated-image`);
    console.log(`Health check: GET http://localhost:${PORT}/health`);
    console.log(`API docs: GET http://localhost:${PORT}/api-docs`);
    console.log(`📁 Uploads: ${uploadsDir}`);
    console.log(`📁 Outputs: ${outputsDir}`);
    console.log(`🗑️ Auto-cleanup: Files deleted 10 seconds after processing`);
    console.log(`🧹 Periodic cleanup: Orphaned files removed every hour`);
    console.log(`For ngrok usage:`);
    console.log(`1. Upload image to: POST https://43e6-42-200-214-30.ngrok-free.app/generated-image`);
    console.log(`2. Processing returns SVG/JSON URLs and automatically cleans up files after 10 seconds`);
}); 