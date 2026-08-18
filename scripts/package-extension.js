#!/usr/bin/env node

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST_DIR = path.join(ROOT, 'dist');

// Keep this list explicit. It is both the package manifest, the locale allowlist,
// and the guard against accidentally shipping tests, documentation, local
// configuration, or build output. Entries are sorted before writing so the
// archive is reproducible.
const RUNTIME_FILES = [
    '_locales/en/messages.json',
    '_locales/tr/messages.json',
    'manifest.json',
    'background.js',
    'content-script.js',
    'popup.html',
    'popup.js',
    'favicon.png',
    'favicon.svg',
    'assets/icon-refresh-em-16.png',
    'assets/icon-refresh-em-32.png',
    'assets/icon-refresh-em-48.png',
    'assets/icon-refresh-em-128.png',
    'assets/icon-refresh-em-colorful-16.png',
    'assets/icon-refresh-em-colorful-32.png',
    'assets/icon-refresh-em-colorful-48.png',
    'assets/icon-refresh-em-colorful-128.png'
].sort();

const ZIP_LOCAL_FILE_HEADER = 0x04034b50;
const ZIP_CENTRAL_DIRECTORY_HEADER = 0x02014b50;
const ZIP_END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP_VERSION = 20;
const ZIP_UTF8_FLAG = 0x0800;
const ZIP_STORE_METHOD = 0;
const ZIP_DOS_TIME = 0;
const ZIP_DOS_DATE = (1 << 5) | 1; // 1980-01-01, the ZIP epoch.
const ZIP_UNIX_VERSION = (3 << 8) | ZIP_VERSION;
const ZIP_FILE_MODE = (0o100644 * 0x10000) >>> 0;

function readJson(relativePath) {
    return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function getReleaseMetadata() {
    const packageJson = readJson('package.json');
    const packageLock = readJson('package-lock.json');
    const manifest = readJson('manifest.json');
    const versions = new Map([
        ['package.json', packageJson.version],
        ['package-lock.json', packageLock.version],
        ['package-lock.json root package', packageLock.packages?.['']?.version],
        ['manifest.json', manifest.version]
    ]);
    const uniqueVersions = new Set(versions.values());

    if (uniqueVersions.size !== 1 || uniqueVersions.has(undefined)) {
        const details = [...versions]
            .map(([source, version]) => `${source}=${version ?? '<missing>'}`)
            .join(', ');
        throw new Error(`Release versions are inconsistent: ${details}`);
    }

    const version = packageJson.version;
    if (!/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) {
        throw new Error(`Version ${version} is not valid for a Chrome extension manifest`);
    }

    return {
        manifest,
        version,
        zipPath: path.join(DIST_DIR, `${packageJson.name}-v${version}.zip`)
    };
}

function addPath(target, value) {
    if (typeof value === 'string' && value.length > 0) {
        target.add(value);
    }
}

function collectManifestRuntimeFiles(manifest) {
    const files = new Set(['manifest.json']);

    addPath(files, manifest.action?.default_popup);
    Object.values(manifest.action?.default_icon || {}).forEach(value => addPath(files, value));
    Object.values(manifest.icons || {}).forEach(value => addPath(files, value));
    addPath(files, manifest.background?.service_worker);
    (manifest.background?.scripts || []).forEach(value => addPath(files, value));
    addPath(files, manifest.options_page);
    addPath(files, manifest.options_ui?.page);
    addPath(files, manifest.devtools_page);
    addPath(files, manifest.side_panel?.default_path);
    addPath(files, manifest.storage?.managed_schema);
    addPath(files, manifest.user_scripts?.api_script);
    Object.values(manifest.chrome_url_overrides || {}).forEach(value => addPath(files, value));
    Object.values(manifest.theme?.images || {}).forEach(value => addPath(files, value));
    (manifest.sandbox?.pages || []).forEach(value => addPath(files, value));
    (manifest.declarative_net_request?.rule_resources || [])
        .forEach(resource => addPath(files, resource.path));

    for (const script of manifest.content_scripts || []) {
        (script.js || []).forEach(value => addPath(files, value));
        (script.css || []).forEach(value => addPath(files, value));
    }

    for (const resourceGroup of manifest.web_accessible_resources || []) {
        (resourceGroup.resources || []).forEach(value => addPath(files, value));
    }

    return files;
}

function normalizeRuntimeReference(fromPath, reference) {
    const withoutSuffix = reference.split(/[?#]/, 1)[0];
    if (!withoutSuffix || /^(?:[a-z]+:|\/\/|#)/i.test(withoutSuffix)) {
        return null;
    }
    return path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), withoutSuffix));
}

function collectHtmlRuntimeFiles(htmlPath) {
    const html = fs.readFileSync(path.join(ROOT, htmlPath), 'utf8');
    const files = new Set();
    const referencePattern = /\b(?:href|src)\s*=\s*["']([^"']+)["']/gi;
    let match;

    while ((match = referencePattern.exec(html)) !== null) {
        const reference = normalizeRuntimeReference(htmlPath, match[1]);
        if (reference) files.add(reference);
    }

    return files;
}

function collectCssRuntimeFiles(cssPath) {
    const css = fs.readFileSync(path.join(ROOT, cssPath), 'utf8');
    const files = new Set();
    const referencePattern = /url\(\s*["']?([^"')]+)["']?\s*\)/gi;
    let match;

    while ((match = referencePattern.exec(css)) !== null) {
        const reference = normalizeRuntimeReference(cssPath, match[1].trim());
        if (reference) files.add(reference);
    }

    return files;
}

function collectJavaScriptRuntimeFiles(scriptPath) {
    const script = fs.readFileSync(path.join(ROOT, scriptPath), 'utf8');
    const files = new Set();
    const referencePattern = /\b(?:chrome|browser)\.runtime\.getURL\(\s*["']([^"']+)["']\s*\)/g;
    let match;

    while ((match = referencePattern.exec(script)) !== null) {
        const reference = normalizeRuntimeReference(scriptPath, match[1]);
        if (reference) files.add(reference);
    }

    return files;
}

function collectReferencedRuntimeFiles(manifest) {
    const referenced = collectManifestRuntimeFiles(manifest);
    const inspected = new Set();
    const queue = [...referenced];

    while (queue.length > 0) {
        const runtimePath = queue.shift();
        if (inspected.has(runtimePath) || !RUNTIME_FILES.includes(runtimePath)) continue;
        inspected.add(runtimePath);

        let nested = [];
        if (runtimePath.endsWith('.html')) nested = collectHtmlRuntimeFiles(runtimePath);
        if (runtimePath.endsWith('.css')) nested = collectCssRuntimeFiles(runtimePath);
        if (runtimePath.endsWith('.js')) nested = collectJavaScriptRuntimeFiles(runtimePath);

        for (const nestedPath of nested) {
            if (!referenced.has(nestedPath)) {
                referenced.add(nestedPath);
                queue.push(nestedPath);
            }
        }
    }

    return referenced;
}

function validateLocales(manifest, allowed) {
    const localesRoot = path.join(ROOT, '_locales');
    const defaultLocaleFile = manifest.default_locale
        ? `_locales/${manifest.default_locale}/messages.json`
        : null;

    if (!fs.existsSync(localesRoot)) {
        if (defaultLocaleFile) throw new Error(`Default locale file is missing: ${defaultLocaleFile}`);
        return;
    }

    const localeFiles = [];
    for (const locale of fs.readdirSync(localesRoot, { withFileTypes: true })) {
        const localeDirectory = `_locales/${locale.name}`;
        if (!locale.isDirectory()) {
            throw new Error(`Unexpected entry in _locales: ${localeDirectory}`);
        }

        const entries = fs.readdirSync(path.join(localesRoot, locale.name), { withFileTypes: true });
        if (entries.length !== 1 || entries[0].name !== 'messages.json' || !entries[0].isFile()) {
            throw new Error(`Locale directory must contain exactly messages.json: ${localeDirectory}`);
        }

        const localeFile = `${localeDirectory}/messages.json`;
        try {
            JSON.parse(fs.readFileSync(path.join(ROOT, localeFile), 'utf8'));
        } catch (error) {
            throw new Error(`Locale ${locale.name} has invalid messages.json: ${error.message}`);
        }
        localeFiles.push(localeFile);
    }

    if (defaultLocaleFile && !localeFiles.includes(defaultLocaleFile)) {
        throw new Error(`Default locale file is missing: ${defaultLocaleFile}`);
    }

    const missingLocales = localeFiles.filter(file => !allowed.has(file)).sort();
    if (missingLocales.length > 0) {
        throw new Error(`Locale files present but not packaged: ${missingLocales.join(', ')}`);
    }
}

function validateRuntimeAllowlist(manifest) {
    const allowed = new Set(RUNTIME_FILES);
    const referenced = collectReferencedRuntimeFiles(manifest);

    const missingReferences = [...referenced].filter(file => !allowed.has(file)).sort();
    if (missingReferences.length > 0) {
        throw new Error(`Runtime files referenced but not packaged: ${missingReferences.join(', ')}`);
    }

    validateLocales(manifest, allowed);

    for (const relativePath of RUNTIME_FILES) {
        if (path.posix.isAbsolute(relativePath) || relativePath.includes('..')) {
            throw new Error(`Unsafe runtime path: ${relativePath}`);
        }

        const absolutePath = path.join(ROOT, relativePath);
        const stat = fs.statSync(absolutePath, { throwIfNoEntry: false });
        if (!stat?.isFile()) {
            throw new Error(`Runtime file is missing or is not a regular file: ${relativePath}`);
        }
    }
}

const CRC32_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let index = 0; index < table.length; index += 1) {
        let value = index;
        for (let bit = 0; bit < 8; bit += 1) {
            value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
        }
        table[index] = value >>> 0;
    }
    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;
    for (const byte of buffer) {
        crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function buildZip() {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;

    for (const relativePath of RUNTIME_FILES) {
        const filename = Buffer.from(relativePath, 'utf8');
        const data = fs.readFileSync(path.join(ROOT, relativePath));
        const checksum = crc32(data);
        const localHeader = Buffer.alloc(30);

        localHeader.writeUInt32LE(ZIP_LOCAL_FILE_HEADER, 0);
        localHeader.writeUInt16LE(ZIP_VERSION, 4);
        localHeader.writeUInt16LE(ZIP_UTF8_FLAG, 6);
        localHeader.writeUInt16LE(ZIP_STORE_METHOD, 8);
        localHeader.writeUInt16LE(ZIP_DOS_TIME, 10);
        localHeader.writeUInt16LE(ZIP_DOS_DATE, 12);
        localHeader.writeUInt32LE(checksum, 14);
        localHeader.writeUInt32LE(data.length, 18);
        localHeader.writeUInt32LE(data.length, 22);
        localHeader.writeUInt16LE(filename.length, 26);
        localHeader.writeUInt16LE(0, 28);
        localParts.push(localHeader, filename, data);

        const centralHeader = Buffer.alloc(46);
        centralHeader.writeUInt32LE(ZIP_CENTRAL_DIRECTORY_HEADER, 0);
        centralHeader.writeUInt16LE(ZIP_UNIX_VERSION, 4);
        centralHeader.writeUInt16LE(ZIP_VERSION, 6);
        centralHeader.writeUInt16LE(ZIP_UTF8_FLAG, 8);
        centralHeader.writeUInt16LE(ZIP_STORE_METHOD, 10);
        centralHeader.writeUInt16LE(ZIP_DOS_TIME, 12);
        centralHeader.writeUInt16LE(ZIP_DOS_DATE, 14);
        centralHeader.writeUInt32LE(checksum, 16);
        centralHeader.writeUInt32LE(data.length, 20);
        centralHeader.writeUInt32LE(data.length, 24);
        centralHeader.writeUInt16LE(filename.length, 28);
        centralHeader.writeUInt16LE(0, 30);
        centralHeader.writeUInt16LE(0, 32);
        centralHeader.writeUInt16LE(0, 34);
        centralHeader.writeUInt16LE(0, 36);
        centralHeader.writeUInt32LE(ZIP_FILE_MODE, 38);
        centralHeader.writeUInt32LE(localOffset, 42);
        centralParts.push(centralHeader, filename);

        localOffset += localHeader.length + filename.length + data.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(ZIP_END_OF_CENTRAL_DIRECTORY, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(RUNTIME_FILES.length, 8);
    end.writeUInt16LE(RUNTIME_FILES.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(localOffset, 16);
    end.writeUInt16LE(0, 20);

    return Buffer.concat([...localParts, centralDirectory, end]);
}

function parseZip(zipBuffer) {
    const endOffset = zipBuffer.length - 22;
    if (endOffset < 0 || zipBuffer.readUInt32LE(endOffset) !== ZIP_END_OF_CENTRAL_DIRECTORY) {
        throw new Error('ZIP end-of-central-directory record is missing');
    }

    const diskNumber = zipBuffer.readUInt16LE(endOffset + 4);
    const centralDisk = zipBuffer.readUInt16LE(endOffset + 6);
    const entryCount = zipBuffer.readUInt16LE(endOffset + 10);
    const centralSize = zipBuffer.readUInt32LE(endOffset + 12);
    const centralOffset = zipBuffer.readUInt32LE(endOffset + 16);
    const commentLength = zipBuffer.readUInt16LE(endOffset + 20);

    if (diskNumber !== 0 || centralDisk !== 0 || commentLength !== 0) {
        throw new Error('Multi-disk or commented ZIP archives are not supported');
    }
    if (centralOffset + centralSize !== endOffset) {
        throw new Error('ZIP central-directory bounds are invalid');
    }

    const entries = [];
    let offset = centralOffset;
    for (let index = 0; index < entryCount; index += 1) {
        if (zipBuffer.readUInt32LE(offset) !== ZIP_CENTRAL_DIRECTORY_HEADER) {
            throw new Error(`Invalid central-directory entry at byte ${offset}`);
        }

        const method = zipBuffer.readUInt16LE(offset + 10);
        const checksum = zipBuffer.readUInt32LE(offset + 16);
        const compressedSize = zipBuffer.readUInt32LE(offset + 20);
        const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
        const filenameLength = zipBuffer.readUInt16LE(offset + 28);
        const extraLength = zipBuffer.readUInt16LE(offset + 30);
        const entryCommentLength = zipBuffer.readUInt16LE(offset + 32);
        const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);
        const filenameStart = offset + 46;
        const filename = zipBuffer.toString('utf8', filenameStart, filenameStart + filenameLength);

        if (filenameStart + filenameLength + extraLength + entryCommentLength > endOffset) {
            throw new Error(`Central-directory entry extends beyond the ZIP bounds: ${filename}`);
        }
        if (method !== ZIP_STORE_METHOD || compressedSize !== uncompressedSize) {
            throw new Error(`Unexpected compression method for ${filename}`);
        }
        if (path.posix.isAbsolute(filename) || filename.split('/').includes('..')) {
            throw new Error(`Unsafe path in ZIP: ${filename}`);
        }
        if (zipBuffer.readUInt32LE(localHeaderOffset) !== ZIP_LOCAL_FILE_HEADER) {
            throw new Error(`Invalid local header for ${filename}`);
        }

        const localFilenameLength = zipBuffer.readUInt16LE(localHeaderOffset + 26);
        const localExtraLength = zipBuffer.readUInt16LE(localHeaderOffset + 28);
        const dataStart = localHeaderOffset + 30 + localFilenameLength + localExtraLength;
        if (dataStart + compressedSize > centralOffset) {
            throw new Error(`Local entry extends beyond the file-data region: ${filename}`);
        }
        const data = zipBuffer.subarray(dataStart, dataStart + compressedSize);
        const localFilename = zipBuffer.toString(
            'utf8',
            localHeaderOffset + 30,
            localHeaderOffset + 30 + localFilenameLength
        );

        if (localFilename !== filename || data.length !== uncompressedSize || crc32(data) !== checksum) {
            throw new Error(`ZIP entry is corrupt or inconsistent: ${filename}`);
        }

        entries.push({ filename, data });
        offset = filenameStart + filenameLength + extraLength + entryCommentLength;
    }

    if (offset !== centralOffset + centralSize) {
        throw new Error('ZIP central-directory entry count or size is invalid');
    }

    return entries;
}

function extractZip(zipPath, destination) {
    const entries = parseZip(fs.readFileSync(zipPath));
    const destinationRoot = path.resolve(destination);
    fs.mkdirSync(destinationRoot, { recursive: true });

    for (const entry of entries) {
        const targetPath = path.resolve(destinationRoot, ...entry.filename.split('/'));
        if (!targetPath.startsWith(`${destinationRoot}${path.sep}`)) {
            throw new Error(`ZIP entry escapes the extraction directory: ${entry.filename}`);
        }
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, entry.data, { mode: 0o644, flag: 'wx' });
    }

    return entries.map(entry => entry.filename);
}

function verifyZip(zipPath, manifest) {
    validateRuntimeAllowlist(manifest);
    const zipBuffer = fs.readFileSync(zipPath);
    const entries = parseZip(zipBuffer);
    const filenames = entries.map(entry => entry.filename);

    if (new Set(filenames).size !== filenames.length) {
        throw new Error('ZIP contains duplicate entries');
    }
    if (JSON.stringify(filenames) !== JSON.stringify(RUNTIME_FILES)) {
        throw new Error(
            `ZIP file list differs from the runtime allowlist:\n` +
            `expected=${JSON.stringify(RUNTIME_FILES)}\nactual=${JSON.stringify(filenames)}`
        );
    }

    for (const entry of entries) {
        const source = fs.readFileSync(path.join(ROOT, entry.filename));
        if (!entry.data.equals(source)) {
            throw new Error(`ZIP content differs from source: ${entry.filename}`);
        }
    }

    return { filenames, size: zipBuffer.length };
}

function writeZip(zipPath, manifest) {
    validateRuntimeAllowlist(manifest);
    fs.mkdirSync(DIST_DIR, { recursive: true });
    const temporaryPath = `${zipPath}.tmp-${process.pid}`;

    try {
        fs.writeFileSync(temporaryPath, buildZip(), { mode: 0o644 });
        fs.rmSync(zipPath, { force: true });
        fs.renameSync(temporaryPath, zipPath);
    } finally {
        fs.rmSync(temporaryPath, { force: true });
    }
}

function main() {
    const verifyOnly = process.argv.includes('--verify-only');
    const checkMetadataOnly = process.argv.includes('--check-metadata');
    const expectedTagArgument = process.argv.find(argument => argument.startsWith('--expected-tag='));
    const expectedTag = expectedTagArgument?.slice('--expected-tag='.length);
    const supportedArguments = new Set(['--verify-only', '--check-metadata']);
    const unknownArguments = process.argv.slice(2).filter(argument =>
        !supportedArguments.has(argument) && !argument.startsWith('--expected-tag='));

    if (unknownArguments.length > 0) {
        throw new Error(`Unknown packaging argument(s): ${unknownArguments.join(', ')}`);
    }
    if (verifyOnly && checkMetadataOnly) {
        throw new Error('--verify-only and --check-metadata cannot be used together');
    }

    const { manifest, version, zipPath } = getReleaseMetadata();
    validateRuntimeAllowlist(manifest);

    if (expectedTag && expectedTag !== `v${version}`) {
        throw new Error(`Release tag ${expectedTag} does not match package version v${version}`);
    }
    if (checkMetadataOnly) {
        console.log(`Verified release metadata for version ${version}${expectedTag ? ` and tag ${expectedTag}` : ''}`);
        return;
    }

    if (!verifyOnly) {
        writeZip(zipPath, manifest);
    }
    if (!fs.existsSync(zipPath)) {
        throw new Error(`Package does not exist: ${path.relative(ROOT, zipPath)}`);
    }

    const result = verifyZip(zipPath, manifest);
    console.log(`${verifyOnly ? 'Verified' : 'Created'} ${path.relative(ROOT, zipPath)}`);
    console.log(`Version: ${version}`);
    console.log(`Size: ${result.size} bytes`);
    console.log('Files:');
    result.filenames.forEach(filename => console.log(`  ${filename}`));
}

if (require.main === module) {
    try {
        main();
    } catch (error) {
        console.error(`Packaging failed: ${error.message}`);
        process.exitCode = 1;
    }
}

module.exports = {
    RUNTIME_FILES,
    extractZip,
    getReleaseMetadata,
    parseZip,
    validateRuntimeAllowlist,
    verifyZip,
    writeZip
};
