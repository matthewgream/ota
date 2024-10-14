#!/usr/bin/env node

// -----------------------------------------------------------------------------------------------------------------------------------------

const name = `ota_server`;
const host = process.env.HOST || 'ota.local';
const port = process.env.PORT || 8090;
const data = process.env.DATA || '/opt/ota/images';

// -----------------------------------------------------------------------------------------------------------------------------------------

const exp = require ('express');
const app = exp ();

const server = require ('http').createServer (app);

// -----------------------------------------------------------------------------------------------------------------------------------------

const fs = require ('fs');
const path = require ('path');
const zlib = require ('zlib');
const multer = require ('multer');
const semver = require ('semver');

const image_upload = multer ({ dest: '/tmp' });
const image_dataType = (filename) => filename.match (/^([^_]+)/)?.[1] || '';
const image_dataVersion = (filename) => filename.match (/_v(\d+\.\d+\.\d+)/)?.[1] || '';
const image_dataCompress = (data) => zlib.deflateSync (data);
const image_dataManifest = (directory) => 
	Object.values (fs.readdirSync (directory).filter (file => !file.startsWith ('.')).reduce ((images, filename) => {
        const type = image_dataType (filename), version = image_dataVersion (filename);
        if (!images [type] || images [type].version < version)
            images [type] = { type, version, filename };
        return images;
    }, {}));

//

const parseFilename = (filename) => {
    const match = filename.match (/^(.+)-(.+)_v(\d+\.\d+\.\d+)\.bin\.zz$/);
    return match ? { name: match [1], platform: match [2], version: match [3] } : null;
};
const groupAndSortFiles = (files) => {
    const groups = {};
    files.forEach (file => {
        const info = parseFilename (file);
        if (info) {
            if (!groups [info.name]) 
                groups [info.name] = {};
            if (!groups [info.name] [info.platform]) 
                groups [info.name] [info.platform] = [];
            groups [info.name] [info.platform].push (info.version);
        }
    });
    Object.keys (groups).forEach (name => {
        Object.keys (groups [name]).forEach (platform =>
            groups [name][platform].sort ((a, b) => semver.rcompare (a, b))
        );
    });
    return groups;
};
const padWithNbsp = (str, length) => {
    return str.padStart (length).replace (/ /g, '&nbsp;');
};
const getFileDetails = (filepath) => {
    const stats = fs.statSync (filepath);
    const mtime = stats.mtime;
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mtimeStr = `${months [mtime.getMonth ()]} ${padWithNbsp (mtime.getDate ().toString (), 2)} ${mtime.getHours ().toString ().padStart (2, '0')}:${mtime.getMinutes ().toString ().padStart (2, '0')}`;
    return `-rw-r--r-- 1 ${process.getuid ()} ${process.getgid ()} ${padWithNbsp (stats.size.toString (), 8)} ${mtimeStr}`;
};
app.get ('/images', (req, res) => {
    try {
        const files = fs.readdirSync (data).filter (file => !file.startsWith ('.')), groups = groupAndSortFiles (files);
        let html = `
	<html>
        <head>
            <style>
                body { font-family: Consolas, monospace; font-size: 11px; margin: 20px; background-color: #f0f0f0; }
                h2 { color: #0066cc; padding: 0px; margin: 0px; margin-top: 10px; }
                h3 { color: #009900; margin: 0px; margin-left: 20px; }
		table { border-collapse: collapse; margin-left: 40px; }
		td { padding: 0 5px 0 0; white-space: nowrap; }
                a { color: #0000cc; text-decoration: none; }
                a:hover { text-decoration: underline; }
                .latest { font-weight: bold; color: #cc0000; }
		.file-details { color: #333; margin-left: 10px; }
		.version-col { width: 160px; }
            </style>
        </head>
        <body>
        `;
        Object.keys (groups).forEach (name => {
            html += `<h2>${name}</h2>`;
            Object.keys (groups [name]).forEach (platform => {
                html += `<h3>${platform}</h3><table>`;
                groups [name][platform].forEach ((version, index) => {
                    const filename = `${name}-${platform}_v${version}.bin.zz`;
                    const filepath = path.join(data, filename);
                    const fileDetails = getFileDetails(filepath);
                    html += `<tr>
                        <td class="version-col"><a href="/images/${filename}">${version}</a>${index === 0 ? ` <span class="latest">(latest)</span>` : ``}</td>
                        <td class="file-details">${fileDetails}</td>
                        <td>${filename}</td>
                    </tr>`;
                });
                html += `</table>`;
            });
        });
        html += `
	</body>
	</html>
	`;
        res.send (html);
    } catch (error) {
        console.error (`/images failed: error <<<${error}>>>`);
        res.status (500).send ('Internal Server Error');
    }
});

//

app.get ('/images/images.json', async (req, res) => {
    const url_base = `http://${host}:${port}/images/`;
    const { type, vers, addr } = req.query;
    const manifest = image_dataManifest (data).map (({ filename, ...rest }) => ({ ...rest, url: url_base + filename }));
    console.log (`/images manifest request: ${manifest.length} items, ${JSON.stringify (manifest).length} bytes, types=[${manifest.map (item => item.type).join (', ')}], type=${type || 'unspecified'}, vers=${vers || 'unspecified'}, addr=${addr || 'unspecified'}`);
    res.json (manifest.filter (item => item.type === type));
});
app.put ('/images', image_upload.single ('image'), (req, res) => {
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
        res.send (`File uploaded, compressed, and saved successfully (${uploadedData.length} compressed to ${compressedData.length}).`);
    } catch (error) {
        console.error (`/images upload failed: error <<<${error}>>> [${req.headers ['x-forwarded-for'] || req.connection.remoteAddress}]`);
        res.status (500).send ('File upload error');
    }
});
app.get ('/images/:filename', (req, res) => {
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

app.get ('/config', (req, res) => {
    const { addr } = req.query;
    if (!addr) {
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

app.use (function (req, res) {
    res.status (404).send ("not found");
});
server.listen (port, function () {
    const { family, address, port } = server.address ();
    console.log (`express up for '${name}' ! -> ${family}/${address}:${port} [${data}]`);
});

// -----------------------------------------------------------------------------------------------------------------------------------------

