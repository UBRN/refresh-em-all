# Contributing to Refresh Em All

Thank you for your interest in contributing to this project! This document provides guidelines for contributing and explains the project structure.

## Repository Structure

- `assets/`: Contains the extension icons in various sizes
- `background.js`: Background script for the extension
- `manifest.json`: Extension manifest file
- `popup.html`: Extension popup UI
- `popup.js`: JavaScript for the popup
- `generate-icons.js`: Utility to generate icon sizes
- `package.json`: NPM package configuration

## Development Workflow

1. Clone the repository
2. Install dependencies: `npm install`
3. Generate icon sizes: `npm run generate-icons`
4. Test the extension locally by loading it as an unpacked extension in Chrome

## .gitignore Explanation

Our `.gitignore` file follows best practices for Chrome extension and Node.js projects:

### Dependency Files
- `node_modules/`: NPM packages (large, regenerable)
- Log files from package managers

### Build Files
- `dist/`, `build/`: Generated output directories
- `*.zip`, `*.crx`, `*.pem`: Extension package files and private keys

### Environment and Editor Files
- `.env*`: Environment variables that may contain secrets
- `.idea/`, `.vscode/`: Editor-specific settings
- `.DS_Store`: macOS system files

### Generated Files
- By default, we track the generated icon files to make it easier for contributors to get started without running the generation script
- If you want to exclude them, uncomment the relevant lines in `.gitignore`

## Pull Request Process

1. Create a new branch for your feature
2. Make your changes
3. Test your changes thoroughly
4. Submit a pull request

## Code Style

Please follow the existing code style in the project.

## License

This project is licensed under the MIT License - see the LICENSE file for details. 