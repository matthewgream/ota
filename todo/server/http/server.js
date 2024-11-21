#!/usr/bin/env node

const name = 'image_server';
const port = process.env.PORT || 9080;
const data = process.env.DATA || '/opt/ota';
const data_images = process.env.DATA_IMAGES || data + '/images';

const exp = require('express');
const app = exp();
const srv = require('http').createServer(app);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const makeDirectory = (dir) => fs.existsSync(dir) || fs.mkdirSync(dir, { recursive: true });
const isValidSerial = (serial) => /^[0-9a-f]{8}$/i.test(serial);

const MAX_FILE_SIZE = 16 * 1024 * 1024 * 1024;  // 16GB
const MAX_CHUNK_SIZE = 100 * 1024 * 1024;   // 100MB

makeDirectory(data_images);

//////////////////////////////////////////////////////////////

app.get('/:serial/:filename', (req, res) => {
    const fileName = path.join(req.params.serial, req.params.filename);
    const filePath = path.join(data_images, fileName);
    if (!isValidSerial(req.params.serial))
        return res.status(400).send(`DOWNLOAD: ${fileName}: failure, bad serial number`);
	//
    if (!fs.existsSync(filePath))
        return res.status(404).send(`DOWNLOAD: ${fileName}: failure, file not found`);
    res.sendFile(filePath, (err) => {
        if (err) {
            console.error(`DOWNLOAD: ${fileName}: failure, error=${err}`);
            return res.status(500).end();
        }
        console.log(`DOWNLOAD: ${fileName}: success`);
    });
});

//////////////////////////////////////////////////////////////

const ensureUploadDir = (serial) => {
    const dir = path.join(data_images, serial);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
    return dir;
};
app.put('/:serial/:filename', exp.raw({ type: 'application/octet-stream', limit: '1gb' }), (req, res) => {
    const fileName = path.join(req.params.serial, req.params.filename);
    const filePath = path.join(data_images, fileName);
    if (!isValidSerial(req.params.serial))
        return res.status(400).send(`UPLOAD: ${fileName}: failure, bad serial number`);
	//
    if (!req.body || !req.body.length)
        return res.status(400).send(`UPLOAD: ${fileName}: failure, file not provided`);
    const hash = crypto.createHash('sha256').update(req.body).digest('hex');
    ensureUploadDir(req.params.serial);
    fs.writeFileSync(filePath, req.body);
    const fileSize = fs.statSync(filePath).size;
    console.log(`UPLOAD: ${fileName}: success, bytes=${fileSize}, hash=${hash}, source=${req.ip}`);
    res.send(`UPLOAD: ${fileName}: success`);
});

//////////////////////////////////////////////////////////////

const CHUNK_TIMEOUT = 5 * 60 * 1000;
const fileChunkHashes = new Map();
const fileTimeouts = new Map();

app.put('/:serial/:filename/chunked', (req, res) => {
    const fileName = path.join(req.params.serial, req.params.filename);
    const filePath = path.join(data_images, fileName);
    if (!isValidSerial(req.params.serial))
        return res.status(400).send(`UPLOAD: ${fileName}: (chunked) failure, bad serial number`);
	//

    makeDirectory(path.join(data_images, req.params.serial));
    const chunk = parseInt(req.query.chunk), final = parseInt(req.query.final);

    if (fileTimeouts.has(fileName)) {
        clearTimeout(fileTimeouts.get(fileName));
        fileTimeouts.delete(fileName);
    }
    if (!final) {
        const timeoutId = setTimeout(() => {
            console.warn(`UPLOAD: ${fileName}: (chunked) timeout`);
            fs.unlink(filePath, (err) => {
                if (err) console.error(`UPLOAD: ${fileName}: (chunked) warning, could not delete partial file, error=${err}`);
            });
            fileChunkHashes.delete(fileName);
            fileTimeouts.delete(fileName);
        }, CHUNK_TIMEOUT);
        fileTimeouts.set(fileName, timeoutId);
    }

    if (chunk === 0) {
        console.info(`UPLOAD: ${fileName}: (chunked) commence, source=${req.ip}`);
        fileChunkHashes.set(fileName, []);
    }
    const chunkHashes = fileChunkHashes.get(fileName);
    if (!(chunkHashes?.length == chunk))
        return res.status(400).send(`UPLOAD: ${fileName}: (chunked) failure, bad chunk number ${chunk}`);

    const totalSize = chunk === 0 ? 0 : fs.statSync(filePath).size;
    const writeStream = fs.createWriteStream(filePath, { flags: chunk === 0 ? 'w' : 'a' });
    const hash = crypto.createHash('sha256');
    let chunkSize = 0;
    let streamError = false;

    writeStream.on('error', (err) => {
        streamError = true;
        console.error(`UPLOAD: ${fileName}: (chunked) failure, error=${err}`);
        fileChunkHashes.delete(fileName);
        if (fileTimeouts.has(fileName)) {
            clearTimeout(fileTimeouts.get(fileName));
            fileTimeouts.delete(fileName);
        }
        if (!res.headersSent)
            res.status(500).send('Storage error');
    });

    req.on('data', chunk => {
        if (!streamError) {
            chunkSize += chunk.length;
            if ((totalSize + chunk.length) > MAX_FILE_SIZE) {
                streamError = true;
                req.destroy(new Error(`UPLOAD: ${fileName}: (chunked) failure, file too large (maximum is ${MAX_FILE_SIZE})`));
                return;
            }
            if (chunk.length > MAX_CHUNK_SIZE) {
                streamError = true;
                req.destroy(new Error(`UPLOAD: ${fileName}: (chunked) failure, chunk too large (maximum is ${MAX_CHUNK_SIZE})`));
                return;
            }
            writeStream.write(chunk);
            hash.update(chunk);
        }
    });

    req.on('end', () => {
        const finalize = () => {
            if (chunkSize === 0 && !final) {
                fileChunkHashes.delete(fileName);
                res.status(400).send(`UPLOAD: ${fileName}: (chunked) failure, empty chunk received`);
                return;
            }
			if (chunkSize !== 0) {
            	const chunkHash = hash.digest('hex');
            	chunkHashes.push(chunkHash);
            	console.log(`UPLOAD: ${fileName}: (chunked) receive, chunk=${chunk}, final=${final}, bytes=${chunkSize}, hash=${chunkHash}`);
			} else
            	console.log(`UPLOAD: ${fileName}: (chunked) receive, chunk=${chunk}, final=${final}`);
            if (!res.headersSent)
                res.send(`UPLOAD: ${fileName}: (chunked) success`);
            if (final) {
                const fileSize = fs.statSync(filePath).size;
                const fileHash = chunkHashes.reduce((prev, curr, index) => index === 0 ? curr : crypto.createHash('sha256').update(prev + curr).digest('hex'));
				if (req.query.hash && req.query.hash !== fileHash) {
                	console.info(`UPLOAD: ${fileName}: (chunked) failed, bytes=${fileSize}, hash=${fileHash} != ${req.query.hash}`);
            		fs.unlink(filePath, (err) => {
                		if (err) console.error(`UPLOAD: ${fileName}: (chunked) warning, could not delete partial file, error=${err}`);
					});
				} else 
                	console.info(`UPLOAD: ${fileName}: (chunked) success, bytes=${fileSize}, hash=${fileHash}`);
        		fileChunkHashes.delete(fileName);
            }
        };
        if (!streamError)
            writeStream.end(() => finalize());
    });

    req.on('error', (err) => {
        streamError = true;
        fileChunkHashes.delete(fileName);
        if (fileTimeouts.has(fileName)) {
            clearTimeout(fileTimeouts.get(fileName));
            fileTimeouts.delete(fileName);
        }
        console.error(`UPLOAD: ${fileName}: (chunked) failure, error=${err}`);
        if (!res.headersSent)
            res.status(500).send(`UPLOAD: ${fileName}: (chunked) failure, error=${err}`);
    });
});

//////////////////////////////////////////////////////////////

app.use((req, res) => res.status(404).send('Not found'));

srv.listen(port, () => {
    const { family, address, port } = srv.address();
    console.log(`${name} server running on ${family}/${address}:${port} [${data}]`);
});

//////////////////////////////////////////////////////////////

