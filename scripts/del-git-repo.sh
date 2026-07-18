#!/bin/bash

# ==============================================================================
# Script to list and delete GitHub repositories matching a specific prefix
# Prefix: "haymant/acp-sit-"
# ==============================================================================

# Ensure GitHub CLI is installed
if ! command -v gh &> /dev/null; then
    echo "Error: github-cli (gh) is not installed."
    echo "Please install it from https://cli.github.com/ and authenticate using 'gh auth login'."
    exit 1
fi

# Ensure user is authenticated
if ! gh auth status &> /dev/null; then
    echo "Error: Not authenticated with GitHub CLI."
    echo "Please run 'gh auth login' to authenticate."
    exit 1
fi

TARGET_PREFIX="haymant/acp-sit-"

echo "Searching for repositories matching prefix: '$TARGET_PREFIX'..."

# Fetch all repositories matching the pattern
REPOS=$(gh repo list haymant --limit 1000 --json nameWithOwner --jq ".[].nameWithOwner" | grep "^${TARGET_PREFIX}")

if [ -z "$REPOS" ]; then
    echo "No repositories found matching the prefix '$TARGET_PREFIX'."
    exit 0
fi

echo ""
echo "The following repositories will be PERMANENTLY DELETED:"
echo "--------------------------------------------------------"
echo "$REPOS"
echo "--------------------------------------------------------"
echo ""

# Prompt for confirmation to prevent accidental destruction
read -p "Are you absolutely sure you want to delete these repositories? (y/N): " CONFIRM
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "Operation aborted. No repositories were deleted."
    exit 0
fi

# Double confirmation safeguard
read -p "Type 'DELETE' to confirm destructive action: " FINAL_CONFIRM
if [ "$FINAL_CONFIRM" != "DELETE" ]; then
    echo "Confirmation failed. Operation aborted."
    exit 1
fi

echo ""
echo "Starting deletion process..."
echo "---------------------------------------------"

# Loop through and delete each repository
for REPO in $REPOS; do
    echo "Deleting: $REPO..."
    gh repo delete "$REPO" --yes
    if [ $? -eq 0 ]; then
        echo "Successfully deleted $REPO"
    else
        echo "Failed to delete $REPO (check your admin/delete token permissions)"
    fi
    echo "---------------------------------------------"
done

echo "Bulk deletion task complete."
