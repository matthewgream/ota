#!/usr/bin/env node

// -----------------------------------------------------------------------------------------------------------------------------------------

const name = 'ota_server';
const host = process.env.HOST || 'ota.local';
const port = process.env.PORT || 8090;
const data = process.env.DATA || '/opt/ota/images';

// -----------------------------------------------------------------------------------------------------------------------------------------

const exp = require ('express');
const xxx = exp ();

const server = require ('http').createServer (xxx);

// -----------------------------------------------------------------------------------------------------------------------------------------

const fs = require ('fs');
const path = require ('path');
const zlib = require ('zlib');
const multer = require ('multer');

const image_upload = multer ({ dest: '/tmp' });
const image_dataType = (filename) => filename.match (/^([^_]+)/)?.[1] || '';
const image_dataVersion = (filename) => filename.match (/_v(\d+\.\d+\.\d+)/)?.[1] || '';
const image_dataCompress = (data) => zlib.deflateSync (data);
const image_dataManifest = (directory) => Object.values (fs.readdirSync (directory).reduce ((images, filename) => {
        const type = image_dataType (filename), version = image_dataVersion (filename);
        if (!images [type] || images [type].version < version)
            images [type] = { type, version, filename };
        return images;
    }, {}));

xxx.get ('/images/images.json', async (req, res) => {
    const url_base = `http://${host}:${port}/images/`;
    const { type, vers, addr } = req.query;
    const manifest = image_dataManifest (data).map (({ filename, ...rest }) => ({ ...rest, url: url_base + filename }));
    console.log (`/images manifest request: ${manifest.length} items, ${JSON.stringify (manifest).length} bytes, types=[${manifest.map (item => item.type).join (', ')}], type=${type || 'unspecified'}, vers=${vers || 'unspecified'}, addr=${addr || 'unspecified'}`);
    res.json (manifest.filter (item => item.type === type));
});
xxx.put ('/images', image_upload.single ('image'), (req, res) => {
    if (!req.file) {
        console.error (`/images upload failed: file not provided`);
        return res.status (400).send ('File not provided');
    }
    if (!req.file.originalname || !image_dataType (req.file.originalname) || !image_dataVersion (req.file.originalname)) {
        console.error (`/images upload failed: file has no name or has bad type/version (received '${req.file.originalname}')`);
        return res.status (400).send ('File has no name or bad type/version');
    }
    if (fs.existsSync (path.join (data, req.file.originalname) + '.zz')) {
        console.error (`/images upload failed: file already exists as '${path.join (data, req.file.originalname)}'`);
        return res.status (409).send ('File with this name already exists');
    }
    try {
        const uploadedName = req.file.originalname, uploadedData = fs.readFileSync (req.file.path); fs.unlinkSync (req.file.path);
        const compressedName = path.join (data, uploadedName) + '.zz', compressedData = image_dataCompress (uploadedData);
        fs.writeFileSync (compressedName, compressedData);
        console.log (`/images upload succeeded: '${uploadedName}' (${uploadedData.length} bytes) --> '${compressedName}' (${compressedData.length} bytes) [${req.headers ['x-forwarded-for'] || req.connection.remoteAddress}]`);
        res.send ('File uploaded, compressed, and saved successfully.');
    } catch (error) {
        console.error (`/images upload failed: error <<<${error}>>> [${req.headers ['x-forwarded-for'] || req.connection.remoteAddress}]`);
        res.status (500).send ('File upload error');
    }
});
xxx.get ('/images/:filename', (req, res) => {
    const downloadName = req.params.filename, downloadPath = path.join (data, downloadName);
    try {
        res.set ('Content-Type', 'application/octet-stream');
        res.send (fs.readFileSync (downloadPath));
        console.log (`/images download succeeded: ${downloadName} (${downloadPath})`);
    } catch (error) {
        console.error (`/images download failed: ${downloadName} (${downloadPath}), error <<<${error}>>>`);
        res.status (404).send ('File not found');
    }
});

//

xxx.get ('/config', (req, res) => {
    const { addr } = req.query;
    if (!mac) {
        console.error (`/config request failed: no mac address provided`);
        return res.status (400).json ({ error: 'MAC address required' });
    }
    try {
        const config = JSON.parse (fs.readFileSync (path.join (__dirname, 'config.json'), 'utf8'));
        if (!config [mac]) {
            console.log (`/config request failed: no entry for ${mac}`);
            return res.status (404).json ({ error: 'MAC address unknown' });
        }
        res.json (config [mac]);
        console.log (`/config request succeeded: ${mac}`);
    } catch (error) {
        console.error (`/config request failed: error reading config file, error <<${error}>>`);
        res.status (500).json ({ error: 'Internal server error' });
    }
});

//

xxx.use (function (req, res) {
    res.status (404).send ("not found");
});
server.listen (port, function () {
    const { family, address, port } = server.address ();
    console.log (`express up for '${name}' ! -> ${family}/${address}:${port} [${data}]`);
});

// -----------------------------------------------------------------------------------------------------------------------------------------

