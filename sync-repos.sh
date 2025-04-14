#!/bin/bash

# Sync repositories script for refresh-em-all
# This script commits changes and pushes to both public and private repositories
# maintaining different .gitignore configurations for each

set -e

# Check if there are changes to commit
if [ -z "$(git status --porcelain)" ]; then
    echo "No changes to commit"
    exit 0
fi

# Get commit message from argument or prompt
if [ -z "$1" ]; then
    echo "Enter commit message:"
    read COMMIT_MESSAGE
else
    COMMIT_MESSAGE="$1"
fi

# Backup current .gitignore
if [ -f .gitignore ]; then
    cp .gitignore .gitignore.bak
fi

echo "Committing all changes for private repository..."
# Stage all files
git add .

# Commit changes
git commit -m "$COMMIT_MESSAGE"

echo "Pushing to private repository..."
# Push to private repository
git push private main

# If we need to switch .gitignore for public repo
if [ -f .github/public-gitignore ]; then
    echo "Switching to public repository gitignore..."
    cp .github/public-gitignore .gitignore
    git add .gitignore
    git commit -m "Update .gitignore for public repository"
fi

echo "Pushing to public repository..."
# Push to public repository 
git push origin main

# Restore original .gitignore
if [ -f .gitignore.bak ]; then
    echo "Restoring original .gitignore..."
    mv .gitignore.bak .gitignore
    # Don't commit this change, just keep it in working directory
fi

echo "Repository sync complete!" 