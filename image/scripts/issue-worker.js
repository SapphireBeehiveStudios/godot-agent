#!/usr/bin/env node
/**
 * issue-worker.js - Isolated agent that processes GitHub issues
 *
 * Phase-Based Workflow (Phase 1):
 * 1. MAINTAIN: Fix your own broken PRs (failing CI, conflicts, feedback)
 * 2. CREATE: Only claim new issues when maintenance is complete
 *
 * This worker:
 * 1. Clones the repository into its isolated workspace
 * 2. Checks its own open PRs for problems (failing CI, conflicts)
 * 3. Fixes any problems found (auto-rebase, fix common CI failures)
 * 4. Only when all PRs are healthy: looks for new issues
 * 5. Enforces work limits (max N open PRs per worker)
 * 6. Creates PRs and marks issues as done
 * 7. Repeats from step 2
 *
 * Environment:
 *   GITHUB_REPO         - Repository to clone (owner/repo)
 *   GITHUB_BRANCH       - Base branch (default: main)
 *   ISSUE_LABEL         - Label to filter issues (default: agent-ready)
 *   POLL_INTERVAL       - Seconds between polls (default: 60)
 *   MAX_OPEN_PRS        - Max open PRs per worker (default: 10)
 *   AUTO_FIX_CONFLICTS  - Auto-fix merge conflicts (default: true)
 *   AUTO_FIX_GO_MOD     - Auto-fix go mod issues (default: true)
 *   AUTO_FIX_PRECOMMIT  - Auto-fix pre-commit failures (default: true)
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

// Configuration
const GITHUB_REPO = process.env.GITHUB_REPO;
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const ISSUE_LABEL = process.env.ISSUE_LABEL || 'agent-ready';
const POLL_INTERVAL = parseInt(process.env.POLL_INTERVAL || '60', 10) * 1000;
const PROJECT_DIR = '/project';

// Phase 1 Configuration
const MAX_OPEN_PRS = parseInt(process.env.MAX_OPEN_PRS || '10', 10);
const AUTO_FIX_CONFLICTS = process.env.AUTO_FIX_CONFLICTS !== 'false';
const AUTO_FIX_GO_MOD = process.env.AUTO_FIX_GO_MOD !== 'false';
const AUTO_FIX_PRECOMMIT = process.env.AUTO_FIX_PRECOMMIT !== 'false';

// Worker identity
const WORKER_ID = process.env.HOSTNAME || crypto.randomBytes(4).toString('hex');
const BOT_NAME = 'sapphire-bee[bot]';

// GitHub App auth
const GITHUB_APP_ID = process.env.GITHUB_APP_ID;
const GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
let GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY;
const GITHUB_APP_PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH;

// State
let currentIssue = null;
let issuesProcessed = 0;
let prsFixed = 0;
let conflictsResolved = 0;
let stalePRsUpdated = 0;
let githubToken = null;
let tokenExpiry = 0;
let rateLimitedUntil = 0; // Timestamp when rate limit expires

// Claim verification delay (ms) - wait for other workers to potentially claim
const CLAIM_VERIFICATION_DELAY = 3000;

// Claim timeout (ms) - claims older than this are considered stale/abandoned
const CLAIM_TIMEOUT = 2 * 60 * 1000; // 2 minutes

/**
 * Log with worker prefix
 */
function log(message) {
    const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19);
    console.log(`[${timestamp}] [${WORKER_ID}] ${message}`);
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Load GitHub App private key
 */
function loadPrivateKey() {
    if (GITHUB_APP_PRIVATE_KEY) {
        return Buffer.from(GITHUB_APP_PRIVATE_KEY, 'base64').toString('utf-8');
    }
    if (GITHUB_APP_PRIVATE_KEY_PATH) {
        return fs.readFileSync(GITHUB_APP_PRIVATE_KEY_PATH, 'utf-8');
    }
    throw new Error('No GitHub App private key configured');
}

/**
 * Create JWT for GitHub App
 */
function createJWT(privateKey) {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
        iat: now - 60,
        exp: now + 600,
        iss: GITHUB_APP_ID
    };

    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signInput = `${header}.${body}`;

    const sign = crypto.createSign('RSA-SHA256');
    sign.update(signInput);
    const signature = sign.sign(privateKey, 'base64url');

    return `${signInput}.${signature}`;
}

/**
 * Make HTTPS request
 */
function request(options, body = null, retries = 3) {
    return new Promise((resolve, reject) => {
        const attempt = (retriesLeft) => {
            const req = https.request(options, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => {
                    try {
                        resolve({ status: res.statusCode, data: JSON.parse(data) });
                    } catch {
                        resolve({ status: res.statusCode, data });
                    }
                });
            });

            req.on('error', (err) => {
                // Retry on transient network errors
                if (retriesLeft > 0 && (err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND')) {
                    const delay = (retries - retriesLeft + 1) * 1000; // Exponential backoff
                    setTimeout(() => attempt(retriesLeft - 1), delay);
                } else {
                    reject(err);
                }
            });

            if (body) req.write(JSON.stringify(body));
            req.end();
        };

        attempt(retries);
    });
}

/**
 * Get installation access token
 */
async function getInstallationToken() {
    if (githubToken && Date.now() < tokenExpiry) {
        return githubToken;
    }

    const privateKey = loadPrivateKey();
    const jwt = createJWT(privateKey);

    const response = await request({
        hostname: 'api.github.com',
        path: `/app/installations/${GITHUB_APP_INSTALLATION_ID}/access_tokens`,
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${jwt}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'sapphire-bee-agent',
            'X-GitHub-Api-Version': '2022-11-28'
        }
    });

    if (response.status !== 201) {
        throw new Error(`Failed to get installation token: ${JSON.stringify(response.data)}`);
    }

    githubToken = response.data.token;
    tokenExpiry = new Date(response.data.expires_at).getTime() - 60000;

    return githubToken;
}

/**
 * GitHub API call
 */
async function github(method, endpoint, body = null) {
    const token = await getInstallationToken();

    return request({
        hostname: 'api.github.com',
        path: endpoint,
        method,
        headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'sapphire-bee-agent',
            'X-GitHub-Api-Version': '2022-11-28',
            'Content-Type': 'application/json'
        }
    }, body);
}

/**
 * Clone repository if not already cloned
 */
async function ensureRepoCloned() {
    const gitDir = path.join(PROJECT_DIR, '.git');

    if (fs.existsSync(gitDir)) {
        log('Repository already cloned, pulling latest...');
        try {
            execSync(`git fetch origin && git checkout ${GITHUB_BRANCH} && git pull origin ${GITHUB_BRANCH}`, {
                cwd: PROJECT_DIR,
                stdio: 'inherit'
            });
        } catch (err) {
            log(`Warning: git pull failed: ${err.message}`);
        }

        const preCommitConfig = path.join(PROJECT_DIR, '.pre-commit-config.yaml');
        if (fs.existsSync(preCommitConfig)) {
            try {
                const hookFile = path.join(PROJECT_DIR, '.git', 'hooks', 'pre-commit');
                if (!fs.existsSync(hookFile)) {
                    log('Installing git hooks...');
                    execSync('pre-commit install --hook-type pre-commit', {
                        cwd: PROJECT_DIR,
                        stdio: 'pipe'
                    });
                    execSync('pre-commit install --hook-type pre-push', {
                        cwd: PROJECT_DIR,
                        stdio: 'pipe'
                    });
                    log('Git hooks installed');
                }
            } catch (err) {
                log(`Warning: Failed to install git hooks: ${err.message}`);
            }
        }

        return;
    }

    log(`Cloning repository: ${GITHUB_REPO}`);

    const token = await getInstallationToken();
    const cloneUrl = `https://x-access-token:${token}@github.com/${GITHUB_REPO}.git`;

    execSync(`git clone --branch ${GITHUB_BRANCH} ${cloneUrl} .`, {
        cwd: PROJECT_DIR,
        stdio: 'inherit'
    });

    execSync('git config user.name "Sapphire Bee Agent"', { cwd: PROJECT_DIR });
    execSync('git config user.email "2587725+sapphire-bee[bot]@users.noreply.github.com"', { cwd: PROJECT_DIR });

    const preCommitConfig = path.join(PROJECT_DIR, '.pre-commit-config.yaml');
    if (fs.existsSync(preCommitConfig)) {
        log('Installing pre-commit and pre-push hooks...');
        try {
            execSync('pre-commit install --hook-type pre-commit', {
                cwd: PROJECT_DIR,
                stdio: 'inherit'
            });
            execSync('pre-commit install --hook-type pre-push', {
                cwd: PROJECT_DIR,
                stdio: 'inherit'
            });
            log('Git hooks installed successfully');
        } catch (err) {
            log(`Warning: Failed to install git hooks: ${err.message}`);
        }
    }

    log('Repository cloned successfully');
}

/**
 * Clean up stale PR-CLAIM comments across all open PRs
 */
async function cleanupStalePRClaims() {
    const [owner, repo] = GITHUB_REPO.split('/');

    // Get all open PRs
    const response = await github('GET',
        `/repos/${owner}/${repo}/pulls?state=open&per_page=100`
    );

    if (response.status !== 200) {
        return;
    }

    const now = Date.now();
    let cleaned = 0;

    for (const pr of response.data) {
        try {
            const commentsResponse = await github('GET',
                `/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`
            );

            if (commentsResponse.status !== 200) {
                continue;
            }

            const staleClaims = commentsResponse.data.filter(c => {
                if (!c.body || !c.body.startsWith('PR-CLAIM:')) return false;
                const age = now - new Date(c.created_at).getTime();
                return age > CLAIM_TIMEOUT;
            });

            for (const claim of staleClaims) {
                const workerId = claim.body.split(':')[1] || 'unknown';
                log(`Cleaning up stale PR-CLAIM from ${workerId} on PR #${pr.number} (${Math.round((now - new Date(claim.created_at).getTime()) / 1000 / 60)} min old)`);
                await github('DELETE',
                    `/repos/${owner}/${repo}/issues/comments/${claim.id}`
                );
                cleaned++;
            }
        } catch (err) {
            // Continue cleaning other PRs
        }
    }

    if (cleaned > 0) {
        log(`🧹 Cleaned up ${cleaned} stale PR-CLAIM comment(s)`);
    }
}

/**
 * PHASE 1: Check this worker's open PRs for problems
 */
async function checkMyPRs() {
    const [owner, repo] = GITHUB_REPO.split('/');

    // Clean up stale PR claims first
    await cleanupStalePRClaims();

    log('🔍 PHASE 1: Checking my open PRs for problems...');

    const response = await github('GET',
        `/repos/${owner}/${repo}/pulls?state=open&per_page=100`
    );

    if (response.status !== 200) {
        log(`Warning: Failed to fetch PRs: ${response.status}`);
        return { failing: [], conflicts: [], count: 0 };
    }

    // Filter for PRs created by this worker (branch prefix: claude/)
    const myPRs = response.data.filter(pr =>
        pr.head.ref.startsWith('claude/')
    );

    log(`Found ${myPRs.length} of my open PRs`);

    // Refetch each PR individually to get accurate mergeable_state
    // (List endpoint returns undefined for mergeable/mergeable_state)
    const detailedPRs = [];
    for (const pr of myPRs) {
        try {
            const detailResponse = await github('GET',
                `/repos/${owner}/${repo}/pulls/${pr.number}`
            );
            if (detailResponse.status === 200) {
                detailedPRs.push(detailResponse.data);
            } else {
                // Fallback to original PR data if detail fetch fails
                detailedPRs.push(pr);
            }
            // Small delay to avoid overwhelming the connection
            await sleep(100);
        } catch (err) {
            log(`  Warning: Failed to fetch details for PR #${pr.number}: ${err.message}`);
            // Fallback to original PR data on error
            detailedPRs.push(pr);
        }
    }

    const problems = {
        failing: [],
        conflicts: [],
        stale: [],
        count: detailedPRs.length
    };

    const now = Date.now();
    const STALE_DAYS = 14; // PRs older than 14 days are considered stale

    for (const pr of detailedPRs) {
        // Skip PRs that need human review
        const needsHumanReview = pr.labels?.some(l => l.name === 'needs-human-review');
        if (needsHumanReview) {
            log(`  PR #${pr.number}: 👤 Needs human review (skipping)`);
            continue;
        }

        // Check CI status
        try {
            const checksResponse = await github('GET',
                `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs`
            );

            if (checksResponse.status === 200 && checksResponse.data.check_runs) {
                const failedChecks = checksResponse.data.check_runs.filter(
                    c => c.conclusion === 'failure'
                );

                if (failedChecks.length > 0) {
                    log(`  PR #${pr.number}: ❌ ${failedChecks.length} failing checks`);
                    problems.failing.push({ pr, failedChecks });
                }
            }
        } catch (err) {
            log(`  Warning: Failed to check CI for PR #${pr.number}: ${err.message}`);
        }

        // Check for merge conflicts
        if (pr.mergeable_state === 'dirty' || pr.mergeable === false) {
            log(`  PR #${pr.number}: ⚠️  Merge conflicts`);
            problems.conflicts.push(pr);
        }

        // Check if stale (no updates in STALE_DAYS)
        const prAge = now - new Date(pr.updated_at).getTime();
        const ageInDays = Math.floor(prAge / (1000 * 60 * 60 * 24));
        if (ageInDays >= STALE_DAYS) {
            log(`  PR #${pr.number}: 🕰️  Stale (${ageInDays} days old)`);
            problems.stale.push({ pr, ageInDays });
        }
    }

    const totalProblems = problems.failing.length + problems.conflicts.length + problems.stale.length;
    if (totalProblems > 0) {
        log(`⚠️  Found ${totalProblems} problem(s): ${problems.failing.length} failing, ${problems.conflicts.length} conflicts, ${problems.stale.length} stale`);
    } else {
        log(`✅ All ${myPRs.length} PRs are healthy`);
    }

    return problems;
}

/**
 * Use Claude to intelligently resolve merge conflicts
 */
async function resolveConflictsWithClaude(pr) {
    try {
        // Get list of conflicted files
        const conflictedFiles = execSync('git diff --name-only --diff-filter=U', {
            cwd: PROJECT_DIR,
            encoding: 'utf-8'
        }).trim().split('\n').filter(f => f);

        if (conflictedFiles.length === 0) {
            log(`  No conflicted files found`);
            return false;
        }

        log(`  Found ${conflictedFiles.length} conflicted file(s): ${conflictedFiles.join(', ')}`);

        // Get PR context for Claude
        const prContext = `
PR #${pr.number}: ${pr.title}
Description: ${pr.body || 'No description provided'}
Branch: ${pr.head.ref}
`;

        // Get commit messages from this PR branch
        let commitLog = '';
        try {
            commitLog = execSync(`git log origin/${GITHUB_BRANCH}..HEAD --oneline`, {
                cwd: PROJECT_DIR,
                encoding: 'utf-8'
            }).trim();
        } catch (err) {
            commitLog = 'Could not retrieve commit log';
        }

        // Resolve each conflicted file with Claude
        for (const file of conflictedFiles) {
            const filePath = path.join(PROJECT_DIR, file);

            log(`  Asking Claude to resolve conflicts in ${file}...`);

            // Read the file with conflict markers
            let conflictedContent;
            try {
                conflictedContent = fs.readFileSync(filePath, 'utf-8');
            } catch (err) {
                log(`  ⚠️  Could not read ${file}: ${err.message}`);
                return false;
            }

            // Get the base version of the file from main branch
            let baseVersion = '';
            try {
                baseVersion = execSync(`git show origin/${GITHUB_BRANCH}:"${file}"`, {
                    cwd: PROJECT_DIR,
                    encoding: 'utf-8'
                });
            } catch (err) {
                baseVersion = 'File does not exist in base branch (new file)';
            }

            // Call Claude to resolve the conflict
            const prompt = `I'm resolving merge conflicts in a Pull Request. I need your help to intelligently merge the changes.

## PR Context
${prContext}

## Commits in this PR
${commitLog}

## File: ${file}

### Base version (from ${GITHUB_BRANCH} branch):
\`\`\`
${baseVersion}
\`\`\`

### Current version with conflict markers:
\`\`\`
${conflictedContent}
\`\`\`

## Your Task
Analyze the conflicts and provide the fully resolved file content that:
1. Preserves the intent of the PR changes
2. Integrates any new changes from ${GITHUB_BRANCH} that don't conflict
3. Removes all conflict markers (<<<<<<, =======, >>>>>>>)
4. Results in working, correct code

## Important Notes
- You have access to the full project at /project if you need to check other files for context
- The section between <<<<<<< HEAD and ======= is the incoming change from ${GITHUB_BRANCH}
- The section between ======= and >>>>>>> is the PR's change
- Consider the PR's purpose when deciding how to merge

Respond with ONLY the resolved file content. No markdown code blocks, no explanations, just the final merged code.`;

            try {
                // Write prompt to temp file to avoid escaping issues
                const promptFile = path.join(PROJECT_DIR, '.git', `conflict_prompt_${Date.now()}.txt`);
                fs.writeFileSync(promptFile, prompt, 'utf-8');

                // Use Claude in print mode for non-interactive batch processing
                const result = execSync(`cat "${promptFile}" | claude --print`, {
                    cwd: PROJECT_DIR,
                    encoding: 'utf-8',
                    maxBuffer: 10 * 1024 * 1024,
                    timeout: 120000, // 2 minutes for complex conflicts
                    shell: '/bin/bash'
                });

                // Clean up prompt file
                try {
                    fs.unlinkSync(promptFile);
                } catch {}

                // Write the resolved content back
                fs.writeFileSync(filePath, result, 'utf-8');

                // Stage the file
                execSync(`git add "${file}"`, { cwd: PROJECT_DIR, stdio: 'pipe' });

                log(`  ✅ Resolved ${file}`);
            } catch (err) {
                log(`  ❌ Claude failed to resolve ${file}: ${err.message}`);
                return false;
            }
        }

        // Continue the rebase
        try {
            execSync('git rebase --continue', {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });
            return true;
        } catch (err) {
            log(`  ⚠️  Rebase continue failed: ${err.message}`);
            return false;
        }
    } catch (err) {
        log(`  ❌ Error during Claude conflict resolution: ${err.message}`);
        return false;
    }
}

/**
 * PHASE 1: Auto-fix merge conflicts by rebasing
 */
async function autoFixConflicts(pr) {
    if (!AUTO_FIX_CONFLICTS) {
        log(`  Skipping auto-fix (AUTO_FIX_CONFLICTS=false)`);
        return false;
    }

    // Claim PR before working on it
    const claimed = await claimPR(pr);
    if (!claimed) {
        log(`  Could not claim PR #${pr.number}, skipping...`);
        return false;
    }

    log(`  🔧 Auto-fixing merge conflicts in PR #${pr.number}...`);
    const [owner, repo] = GITHUB_REPO.split('/');

    try {
        // Clean workspace
        execSync('git reset --hard HEAD && git clean -fd', {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });

        // Fetch and checkout the PR branch
        execSync(`git fetch origin ${pr.head.ref}`, {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });
        execSync(`git checkout ${pr.head.ref}`, {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });

        // Fetch latest main
        execSync(`git fetch origin ${GITHUB_BRANCH}`, {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });

        // Attempt rebase
        try {
            execSync(`git rebase origin/${GITHUB_BRANCH}`, {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });
            log(`  ✅ Rebase successful`);
        } catch (rebaseErr) {
            // Rebase failed, use Claude to intelligently resolve conflicts
            log(`  ⚠️  Rebase conflicts detected, asking Claude to resolve...`);

            const resolved = await resolveConflictsWithClaude(pr);
            if (!resolved) {
                execSync('git rebase --abort', {
                    cwd: PROJECT_DIR,
                    stdio: 'pipe'
                });
                log(`  ❌ Claude could not resolve conflicts, needs human review`);

                // Add needs-human-review label
                await github('POST',
                    `/repos/${owner}/${repo}/issues/${pr.number}/labels`,
                    { labels: ['needs-human-review'] }
                );

                // Add comment to PR
                await github('POST',
                    `/repos/${owner}/${repo}/issues/${pr.number}/comments`,
                    {
                        body: `⚠️ **Cannot automatically resolve merge conflicts**

**Worker:** \`${WORKER_ID}\`

**What I tried:**
1. Rebased this PR on \`${GITHUB_BRANCH}\`
2. Rebase resulted in merge conflicts
3. Invoked Claude to analyze conflict markers and attempt intelligent resolution
4. Claude could not resolve the conflicts safely

**Why it failed:**
The conflicts are too complex or ambiguous for automated resolution. Manual review is needed to ensure the merge is correct.

**Next steps:**
Please manually rebase this PR on \`${GITHUB_BRANCH}\` and resolve conflicts.

Labeled as \`needs-human-review\`.`
                    }
                );

                return false;
            }

            log(`  ✅ Claude resolved conflicts successfully`);
        }

        // Push the rebased branch
        const token = await getInstallationToken();
        execSync(`git push https://x-access-token:${token}@github.com/${GITHUB_REPO}.git ${pr.head.ref} --force-with-lease`, {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });

        // Comment on PR
        await github('POST',
            `/repos/${owner}/${repo}/issues/${pr.number}/comments`,
            {
                body: `✅ Rebased on latest \`${GITHUB_BRANCH}\`, conflicts resolved automatically.`
            }
        );

        conflictsResolved++;
        log(`  ✅ Fixed merge conflicts in PR #${pr.number}`);
        return true;

    } catch (err) {
        log(`  ❌ Failed to fix conflicts: ${err.message}`);
        return false;
    } finally {
        // Return to main branch
        try {
            execSync('git reset --hard HEAD && git clean -fd', {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });
            execSync(`git checkout ${GITHUB_BRANCH}`, {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });
        } catch {}
    }
}

/**
 * PHASE 1: Auto-fix common CI failures
 */
async function autoFixCIFailures(pr, failedChecks) {
    // Claim PR before working on it
    const claimed = await claimPR(pr);
    if (!claimed) {
        log(`  Could not claim PR #${pr.number}, skipping...`);
        return false;
    }

    log(`  🔧 Analyzing CI failures for PR #${pr.number}...`);
    const [owner, repo] = GITHUB_REPO.split('/');

    try {
        // Clean workspace
        execSync('git reset --hard HEAD && git clean -fd', {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });

        // Checkout PR branch
        execSync(`git fetch origin ${pr.head.ref}`, {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });
        execSync(`git checkout ${pr.head.ref}`, {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });

        let fixed = false;

        // Check for go mod issues
        if (AUTO_FIX_GO_MOD) {
            for (const check of failedChecks) {
                if (check.name.includes('go') || check.name.includes('build')) {
                    log(`  Attempting go mod tidy...`);
                    try {
                        execSync('go mod tidy', { cwd: PROJECT_DIR, stdio: 'pipe' });
                        execSync('git add go.mod go.sum', { cwd: PROJECT_DIR, stdio: 'pipe' });
                        execSync('git commit -m "fix: run go mod tidy"', {
                            cwd: PROJECT_DIR,
                            stdio: 'pipe'
                        });
                        fixed = true;
                        log(`  ✅ Fixed go mod issues`);
                    } catch {
                        // No changes or command failed
                    }
                    break;
                }
            }
        }

        // Check for pre-commit issues
        if (AUTO_FIX_PRECOMMIT) {
            for (const check of failedChecks) {
                if (check.name.includes('pre-commit') || check.name.includes('lint')) {
                    log(`  Attempting pre-commit auto-fix...`);
                    try {
                        execSync('pre-commit run --all-files', {
                            cwd: PROJECT_DIR,
                            stdio: 'pipe'
                        });
                        // Pre-commit may have modified files
                        const status = execSync('git status --porcelain', {
                            cwd: PROJECT_DIR
                        }).toString();

                        if (status.trim()) {
                            execSync('git add -A', { cwd: PROJECT_DIR, stdio: 'pipe' });
                            execSync('git commit -m "fix: apply pre-commit hooks"', {
                                cwd: PROJECT_DIR,
                                stdio: 'pipe'
                            });
                            fixed = true;
                            log(`  ✅ Fixed pre-commit issues`);
                        }
                    } catch {
                        // Pre-commit failed or no changes
                    }
                    break;
                }
            }
        }

        if (fixed) {
            // Push the fixes
            const token = await getInstallationToken();
            execSync(`git push https://x-access-token:${token}@github.com/${GITHUB_REPO}.git ${pr.head.ref}`, {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });

            // Comment on PR
            await github('POST',
                `/repos/${owner}/${repo}/issues/${pr.number}/comments`,
                {
                    body: `🔧 Auto-fixed CI failures (go mod tidy, pre-commit hooks).`
                }
            );

            prsFixed++;
            log(`  ✅ Fixed CI failures in PR #${pr.number}`);
            return true;
        } else {
            log(`  ℹ️  No auto-fixable CI issues found`);
            return false;
        }

    } catch (err) {
        log(`  ❌ Failed to fix CI: ${err.message}`);
        return false;
    } finally {
        // Return to main branch
        try {
            execSync('git reset --hard HEAD && git clean -fd', {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });
            execSync(`git checkout ${GITHUB_BRANCH}`, {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });
        } catch {}
    }
}

/**
 * PHASE 1: Update stale PRs by rebasing on main
 */
async function updateStalePRs(stalePRs) {
    const [owner, repo] = GITHUB_REPO.split('/');

    // Sort by age (newest first) - give recent PRs priority
    stalePRs.sort((a, b) => a.ageInDays - b.ageInDays);

    for (const { pr, ageInDays } of stalePRs) {
        log(`  🔄 Updating stale PR #${pr.number} (${ageInDays} days old)...`);

        // Claim PR before working on it
        const claimed = await claimPR(pr);
        if (!claimed) {
            log(`  Could not claim PR #${pr.number}, skipping...`);
            continue;
        }

        try {
            // Clean workspace
            execSync('git reset --hard HEAD && git clean -fd', {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });

            // Fetch and checkout the PR branch
            execSync(`git fetch origin ${pr.head.ref}`, {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });
            execSync(`git checkout ${pr.head.ref}`, {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });

            // Fetch latest main
            execSync(`git fetch origin ${GITHUB_BRANCH}`, {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });

            // Attempt rebase to bring PR up to date
            try {
                execSync(`git rebase origin/${GITHUB_BRANCH}`, {
                    cwd: PROJECT_DIR,
                    stdio: 'pipe'
                });
                log(`  ✅ Rebased successfully`);
            } catch (rebaseErr) {
                // Rebase failed, try auto-resolution
                log(`  ⚠️  Rebase conflicts, attempting auto-resolution...`);

                try {
                    execSync('git checkout --ours .', {
                        cwd: PROJECT_DIR,
                        stdio: 'pipe'
                    });
                    execSync('git add .', { cwd: PROJECT_DIR, stdio: 'pipe' });
                    execSync('git rebase --continue', {
                        cwd: PROJECT_DIR,
                        stdio: 'pipe'
                    });
                    log(`  ✅ Auto-resolved conflicts`);
                } catch {
                    // Can't auto-resolve, abort
                    execSync('git rebase --abort', {
                        cwd: PROJECT_DIR,
                        stdio: 'pipe'
                    });
                    log(`  ❌ Cannot auto-resolve, skipping this PR`);
                    continue;
                }
            }

            // Push the updated branch
            const token = await getInstallationToken();
            execSync(`git push https://x-access-token:${token}@github.com/${GITHUB_REPO}.git ${pr.head.ref} --force-with-lease`, {
                cwd: PROJECT_DIR,
                stdio: 'pipe'
            });

            // Comment on PR
            await github('POST',
                `/repos/${owner}/${repo}/issues/${pr.number}/comments`,
                {
                    body: `🔄 Rebased on latest \`${GITHUB_BRANCH}\` to bring this PR up to date (was ${ageInDays} days old).`
                }
            );

            stalePRsUpdated++; // Reusing counter for "PRs updated"
            log(`  ✅ Updated stale PR #${pr.number}`);
        } catch (err) {
            log(`  ❌ Failed to update stale PR #${pr.number}: ${err.message}`);
        } finally {
            // Return to main branch
            try {
                execSync('git reset --hard HEAD && git clean -fd', {
                    cwd: PROJECT_DIR,
                    stdio: 'pipe'
                });
                execSync(`git checkout ${GITHUB_BRANCH}`, {
                    cwd: PROJECT_DIR,
                    stdio: 'pipe'
                });
            } catch {}
        }
    }
}

/**
 * PHASE 1: Fix all problems found in my PRs
 * Only attempts ONE PR fix per cycle to avoid rate limiting
 */
async function fixMyPRs(problems) {
    log('🔧 PHASE 1: Fixing my broken PRs...');

    // Check if we're rate limited
    if (Date.now() < rateLimitedUntil) {
        const minutesLeft = Math.ceil((rateLimitedUntil - Date.now()) / 60000);
        log(`⏸️  Rate limited, waiting ${minutesLeft} more minute(s)...`);
        return;
    }

    // Fix conflicts first (but only ONE per cycle)
    if (problems.conflicts.length > 0) {
        log(`Found ${problems.conflicts.length} PR(s) with conflicts, attempting to fix one...`);
        const fixed = await autoFixConflicts(problems.conflicts[0]);
        if (fixed) {
            log(`✅ Fixed conflict in PR #${problems.conflicts[0].number}`);
        }
        return; // Return after attempting one, check again next cycle
    }

    // Fix failing CI (only ONE per cycle)
    if (problems.failing.length > 0) {
        log(`Found ${problems.failing.length} failing PR(s), attempting to fix one...`);
        const { pr, failedChecks } = problems.failing[0];
        await autoFixCIFailures(pr, failedChecks);
        return; // Return after attempting one
    }

    // Update stale PRs (only ONE per cycle)
    if (problems.stale.length > 0) {
        log(`Found ${problems.stale.length} stale PR(s), updating one...`);
        await updateStalePRs([problems.stale[0]]);
        return; // Return after attempting one
    }

    log(`📊 Session stats: ${prsFixed} PRs fixed, ${conflictsResolved} conflicts resolved, ${stalePRsUpdated} stale PRs updated`);
}

/**
 * Check if worker can claim new issues (work limit)
 */
async function canClaimNewIssue() {
    const problems = await checkMyPRs();

    // Rule 1: Can't claim if we have problems to fix
    if (problems.failing.length > 0 || problems.conflicts.length > 0) {
        log(`❌ Cannot claim new issues: ${problems.failing.length} failing PRs, ${problems.conflicts.length} conflicts`);
        return false;
    }

    // Rule 2: Can't claim if at PR limit
    if (problems.count >= MAX_OPEN_PRS) {
        log(`❌ Cannot claim new issues: at PR limit (${problems.count}/${MAX_OPEN_PRS})`);
        return false;
    }

    log(`✅ Can claim new issues (${problems.count}/${MAX_OPEN_PRS} open PRs, all healthy)`);
    return true;
}

/**
 * Find an available issue to work on
 */
async function findAvailableIssue() {
    const [owner, repo] = GITHUB_REPO.split('/');

    const response = await github('GET',
        `/repos/${owner}/${repo}/issues?labels=${ISSUE_LABEL}&state=open&sort=created&direction=asc`
    );

    if (response.status !== 200) {
        log(`Failed to fetch issues: ${JSON.stringify(response.data)}`);
        return null;
    }

    for (const issue of response.data) {
        const hasInProgress = issue.labels.some(l => l.name === 'in-progress');
        if (!hasInProgress && !issue.pull_request) {
            return issue;
        }
    }

    return null;
}

/**
 * Claim an issue using atomic comment verification
 */
async function claimIssue(issue) {
    const [owner, repo] = GITHUB_REPO.split('/');
    const claimId = `CLAIM:${WORKER_ID}:${Date.now()}`;

    log(`Attempting to claim issue #${issue.number}...`);

    const issueResponse = await github('GET',
        `/repos/${owner}/${repo}/issues/${issue.number}`
    );
    if (issueResponse.status === 200) {
        const hasInProgress = issueResponse.data.labels?.some(l => l.name === 'in-progress');
        if (hasInProgress) {
            log(`Issue #${issue.number} already has in-progress label, skipping...`);
            return false;
        }
    }

    const claimResponse = await github('POST',
        `/repos/${owner}/${repo}/issues/${issue.number}/comments`,
        { body: claimId }
    );

    if (claimResponse.status !== 201) {
        // Check for rate limiting
        if (claimResponse.status === 403 && claimResponse.data.message &&
            claimResponse.data.message.includes('secondary rate limit')) {
            const backoffMinutes = 10;
            rateLimitedUntil = Date.now() + (backoffMinutes * 60 * 1000);
            log(`⚠️  Hit GitHub secondary rate limit! Backing off for ${backoffMinutes} minutes...`);
        } else {
            log(`Failed to post claim comment: ${JSON.stringify(claimResponse.data)}`);
        }
        return false;
    }

    const ourCommentId = claimResponse.data.id;
    log(`Posted claim comment (id: ${ourCommentId}), waiting for other claims...`);

    await sleep(CLAIM_VERIFICATION_DELAY);

    const recheckResponse = await github('GET',
        `/repos/${owner}/${repo}/issues/${issue.number}`
    );
    if (recheckResponse.status === 200) {
        const hasInProgress = recheckResponse.data.labels?.some(l => l.name === 'in-progress');
        if (hasInProgress) {
            log(`Issue #${issue.number} was claimed by another worker (in-progress label found)`);
            await github('DELETE',
                `/repos/${owner}/${repo}/issues/comments/${ourCommentId}`
            );
            return false;
        }
    }

    const commentsResponse = await github('GET',
        `/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=100`
    );

    if (commentsResponse.status !== 200) {
        log(`Failed to fetch comments: ${JSON.stringify(commentsResponse.data)}`);
        return false;
    }

    const now = Date.now();
    const allClaims = commentsResponse.data.filter(c => c.body && c.body.startsWith('CLAIM:'));
    log(`Found ${allClaims.length} total CLAIM comment(s), verifying...`);

    const validClaims = [];
    for (const claim of allClaims) {
        const workerId = claim.body.split(':')[1] || 'unknown';
        const claimAge = now - new Date(claim.created_at).getTime();

        if (claimAge > CLAIM_TIMEOUT) {
            log(`Ignoring stale claim from worker ${workerId} (age: ${Math.round(claimAge / 1000)}s, limit: ${CLAIM_TIMEOUT / 1000}s)`);
            continue;
        }

        try {
            const verifyResponse = await github('GET',
                `/repos/${owner}/${repo}/issues/comments/${claim.id}`
            );
            if (verifyResponse.status !== 200) {
                log(`Ignoring ghost claim from worker ${workerId} (comment ${claim.id} returned ${verifyResponse.status})`);
                continue;
            }
            validClaims.push(claim);
            log(`Verified claim from worker ${workerId} (age: ${Math.round(claimAge / 1000)}s)`);
        } catch (err) {
            log(`Ignoring ghost claim from worker ${workerId} (comment ${claim.id} verification failed: ${err.message})`);
        }
    }

    const claims = validClaims.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (claims.length === 0 || claims[0].id !== ourCommentId) {
        const winner = claims.length > 0 ? claims[0].body.split(':')[1] : 'unknown';
        log(`Lost claim race to worker ${winner}, skipping issue #${issue.number}`);

        await github('DELETE',
            `/repos/${owner}/${repo}/issues/comments/${ourCommentId}`
        );

        return false;
    }

    log(`Won claim for issue #${issue.number}!`);

    const labelResponse = await github('POST',
        `/repos/${owner}/${repo}/issues/${issue.number}/labels`,
        { labels: ['in-progress'] }
    );

    if (labelResponse.status !== 200) {
        log(`Warning: Failed to add in-progress label: ${JSON.stringify(labelResponse.data)}`);
    }

    await github('PATCH',
        `/repos/${owner}/${repo}/issues/comments/${ourCommentId}`,
        { body: `🤖 Agent \`${WORKER_ID}\` claimed and is now working on this issue.` }
    );

    return true;
}

/**
 * Atomic PR claiming to prevent multiple workers from fixing the same PR
 * Similar to issue claiming but for PRs
 */
async function claimPR(pr) {
    const [owner, repo] = GITHUB_REPO.split('/');
    const claimId = `PR-CLAIM:${WORKER_ID}`;

    log(`Attempting to claim PR #${pr.number}...`);

    // Check if PR already has a recent claim comment
    const commentsResponse = await github('GET',
        `/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`
    );

    if (commentsResponse.status === 200) {
        const now = Date.now();
        const recentClaims = commentsResponse.data.filter(c => {
            if (!c.body || !c.body.startsWith('PR-CLAIM:')) return false;
            const age = now - new Date(c.created_at).getTime();
            return age < CLAIM_TIMEOUT;
        });

        if (recentClaims.length > 0) {
            const workerId = recentClaims[0].body.split(':')[1] || 'unknown';
            log(`PR #${pr.number} already claimed by ${workerId}, skipping...`);
            return false;
        }
    }

    // Post claim comment
    const claimResponse = await github('POST',
        `/repos/${owner}/${repo}/issues/${pr.number}/comments`,
        { body: claimId }
    );

    if (claimResponse.status !== 201) {
        // Check for rate limiting
        if (claimResponse.status === 403 && claimResponse.data.message &&
            claimResponse.data.message.includes('secondary rate limit')) {
            const backoffMinutes = 10; // Back off for 10 minutes
            rateLimitedUntil = Date.now() + (backoffMinutes * 60 * 1000);
            log(`⚠️  Hit GitHub secondary rate limit! Backing off for ${backoffMinutes} minutes...`);
        } else {
            log(`Failed to post PR claim comment: ${JSON.stringify(claimResponse.data)}`);
        }
        return false;
    }

    const ourCommentId = claimResponse.data.id;
    log(`Posted PR claim comment (id: ${ourCommentId}), waiting for other claims...`);

    // Wait for race window
    await sleep(CLAIM_VERIFICATION_DELAY);

    // Fetch all claims again and verify we won
    const recheckResponse = await github('GET',
        `/repos/${owner}/${repo}/issues/${pr.number}/comments?per_page=100`
    );

    if (recheckResponse.status !== 200) {
        log(`Failed to fetch PR comments for verification: ${JSON.stringify(recheckResponse.data)}`);
        return false;
    }

    const now = Date.now();
    const allClaims = recheckResponse.data.filter(c => c.body && c.body.startsWith('PR-CLAIM:'));

    const validClaims = [];
    for (const claim of allClaims) {
        const workerId = claim.body.split(':')[1] || 'unknown';
        const claimAge = now - new Date(claim.created_at).getTime();

        if (claimAge > CLAIM_TIMEOUT) {
            log(`Ignoring stale PR claim from worker ${workerId}`);
            continue;
        }

        try {
            const verifyResponse = await github('GET',
                `/repos/${owner}/${repo}/issues/comments/${claim.id}`
            );
            if (verifyResponse.status !== 200) {
                log(`Ignoring ghost PR claim from worker ${workerId}`);
                continue;
            }
            validClaims.push(claim);
        } catch (err) {
            log(`Ignoring invalid PR claim from worker ${workerId}: ${err.message}`);
        }
    }

    const claims = validClaims.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));

    if (claims.length === 0 || claims[0].id !== ourCommentId) {
        const winner = claims.length > 0 ? claims[0].body.split(':')[1] : 'unknown';
        log(`Lost PR claim race to worker ${winner}, skipping PR #${pr.number}`);

        // Delete our claim comment
        await github('DELETE',
            `/repos/${owner}/${repo}/issues/comments/${ourCommentId}`
        );

        return false;
    }

    log(`Won claim for PR #${pr.number}!`);

    // Update comment to indicate we're working on it
    await github('PATCH',
        `/repos/${owner}/${repo}/issues/comments/${ourCommentId}`,
        { body: `🔧 Worker \`${WORKER_ID}\` is fixing this PR...` }
    );

    return true;
}

/**
 * Check if issue has an existing open PR
 */
async function findExistingPR(issue) {
    const [owner, repo] = GITHUB_REPO.split('/');

    const response = await github('GET',
        `/repos/${owner}/${repo}/pulls?state=open&per_page=100`
    );

    if (response.status !== 200) {
        log(`Warning: Failed to fetch PRs: ${response.status}`);
        return null;
    }

    const issueRef = `#${issue.number}`;
    for (const pr of response.data) {
        const titleMatch = pr.title && pr.title.includes(issueRef);
        const bodyMatch = pr.body && pr.body.includes(issueRef);

        if (titleMatch || bodyMatch) {
            log(`Found existing PR #${pr.number} for issue #${issue.number}: ${pr.head.ref}`);
            return {
                number: pr.number,
                branch: pr.head.ref,
                title: pr.title,
                checks_failed: false
            };
        }
    }

    return null;
}

/**
 * Create a working branch for the issue, or check out existing PR branch
 */
async function createWorkingBranch(issue) {
    try {
        log('Cleaning workspace...');
        execSync('git reset --hard HEAD', {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });
        execSync('git clean -fd', {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });
    } catch (err) {
        log(`Warning: Failed to clean workspace: ${err.message}`);
    }

    const existingPR = await findExistingPR(issue);

    if (existingPR) {
        log(`Checking out existing PR branch: ${existingPR.branch}`);

        execSync(`git checkout ${GITHUB_BRANCH}`, {
            cwd: PROJECT_DIR,
            stdio: 'pipe'
        });

        try {
            execSync(`git fetch origin ${existingPR.branch}`, {
                cwd: PROJECT_DIR,
                stdio: 'inherit'
            });
            execSync(`git checkout ${existingPR.branch}`, {
                cwd: PROJECT_DIR,
                stdio: 'inherit'
            });
            execSync(`git pull origin ${existingPR.branch}`, {
                cwd: PROJECT_DIR,
                stdio: 'inherit'
            });

            log(`✓ Checked out existing branch: ${existingPR.branch}`);
            return existingPR.branch;
        } catch (err) {
            log(`Warning: Failed to checkout existing branch, creating new one: ${err.message}`);
        }
    }

    const branchName = `claude/issue-${issue.number}-${Date.now()}`;
    log(`Creating new branch: ${branchName}`);

    execSync(`git checkout ${GITHUB_BRANCH} && git pull origin ${GITHUB_BRANCH}`, {
        cwd: PROJECT_DIR,
        stdio: 'inherit'
    });

    execSync(`git checkout -b ${branchName}`, {
        cwd: PROJECT_DIR,
        stdio: 'inherit'
    });

    return branchName;
}

/**
 * Refresh MCP token in ~/.claude.json
 */
async function refreshMcpToken() {
    try {
        const token = await getInstallationToken();
        const claudeConfigPath = path.join(process.env.HOME || '/home/claude', '.claude.json');

        let config = {};
        if (fs.existsSync(claudeConfigPath)) {
            config = JSON.parse(fs.readFileSync(claudeConfigPath, 'utf-8'));
        }

        if (!config.mcpServers) config.mcpServers = {};
        if (!config.mcpServers.github) {
            config.mcpServers.github = {
                command: 'npx',
                args: ['-y', '@github/github-mcp-server']
            };
        }
        if (!config.mcpServers.github.env) config.mcpServers.github.env = {};
        config.mcpServers.github.env.GITHUB_PERSONAL_ACCESS_TOKEN = token;

        fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
        log('Refreshed MCP token in ~/.claude.json');
    } catch (err) {
        log(`Warning: Failed to refresh MCP token: ${err.message}`);
    }
}

/**
 * Run Claude on the issue
 */
async function runClaude(issue, branchName) {
    const isExistingBranch = branchName.includes('-') &&
                            !branchName.endsWith(Date.now().toString().slice(0, -3));

    const prompt = isExistingBranch
        ? `You are working on GitHub issue #${issue.number}: "${issue.title}"

Issue description:
${issue.body || 'No description provided.'}

IMPORTANT: You are working on an EXISTING branch (${branchName}) that has an open PR.
This means there's already an implementation attempt that may be failing tests or checks.

Instructions:
1. Review the existing code changes in this branch (git log, git diff ${GITHUB_BRANCH})
2. Identify what's failing (check test output, build errors, or issue comments)
3. Fix the problems - don't start from scratch, improve what's there
4. Run tests to verify your fixes work
5. Commit your changes with a clear message explaining what you fixed

When you're done, summarize what was broken and how you fixed it.`
        : `You are working on GitHub issue #${issue.number}: "${issue.title}"

Issue description:
${issue.body || 'No description provided.'}

Instructions:
1. Analyze the issue and understand what needs to be done
2. Make the necessary code changes to address this issue
3. Write tests for your changes
4. Run all tests to verify everything works
5. Commit your changes with a clear commit message referencing the issue

When you're done, summarize what you changed.`;

    log(`Running Claude on issue #${issue.number}...`);
    if (isExistingBranch) {
        log(`📝 Note: Fixing existing PR branch`);
    }

    await refreshMcpToken();

    const logDir = '/pool-logs';
    const logFile = path.join(logDir, `worker-${WORKER_ID}-issue-${issue.number}-${Date.now()}.log`);
    let logStream = null;

    if (fs.existsSync(logDir)) {
        try {
            logStream = fs.createWriteStream(logFile, { flags: 'a' });
            logStream.write(`\n${'═'.repeat(70)}\n`);
            logStream.write(`Worker: ${WORKER_ID}\n`);
            logStream.write(`Issue: #${issue.number} - ${issue.title}\n`);
            logStream.write(`Started: ${new Date().toISOString()}\n`);
            logStream.write(`${'═'.repeat(70)}\n\n`);
            log(`Logging conversation to: ${logFile}`);
        } catch (err) {
            log(`Warning: Failed to create log file: ${err.message}`);
        }
    }

    return new Promise((resolve) => {
        const claude = spawn('claude', [
            '--dangerously-skip-permissions',
            '--no-session-persistence',
            prompt
        ], {
            cwd: PROJECT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, TERM: 'xterm-256color' }
        });

        let output = '';

        claude.stdout.on('data', (data) => {
            const text = data.toString();
            process.stdout.write(text);
            if (logStream) logStream.write(text);
            output += text;
        });

        claude.stderr.on('data', (data) => {
            const text = data.toString();
            process.stderr.write(text);
            if (logStream) logStream.write(`[STDERR] ${text}`);
        });

        claude.on('close', (code) => {
            if (logStream) {
                logStream.write(`\n\n${'═'.repeat(70)}\n`);
                logStream.write(`Finished: ${new Date().toISOString()}\n`);
                logStream.write(`Exit code: ${code}\n`);
                logStream.write(`${'═'.repeat(70)}\n`);
                logStream.end();
            }
            resolve({ success: code === 0, output });
        });

        claude.on('error', (err) => {
            log(`Failed to run Claude: ${err.message}`);
            if (logStream) {
                logStream.write(`\nERROR: ${err.message}\n`);
                logStream.end();
            }
            resolve({ success: false, output: err.message });
        });
    });
}

/**
 * Push branch and create PR
 */
async function createPullRequest(issue, branchName, claudeOutput) {
    const [owner, repo] = GITHUB_REPO.split('/');
    const token = await getInstallationToken();

    log('Pushing branch...');
    execSync(`git push https://x-access-token:${token}@github.com/${GITHUB_REPO}.git ${branchName}`, {
        cwd: PROJECT_DIR,
        stdio: 'inherit'
    });

    log('Creating pull request...');
    const prBody = `## Fixes #${issue.number}

### Changes Made
${claudeOutput.substring(0, 3000)}

---
🤖 *This PR was automatically created by Sapphire Bee Agent \`${WORKER_ID}\`*`;

    const prResponse = await github('POST',
        `/repos/${owner}/${repo}/pulls`,
        {
            title: `Fix: ${issue.title}`,
            body: prBody,
            head: branchName,
            base: GITHUB_BRANCH
        }
    );

    if (prResponse.status !== 201) {
        log(`Failed to create PR: ${JSON.stringify(prResponse.data)}`);
        return null;
    }

    return prResponse.data;
}

/**
 * Complete issue processing
 */
async function completeIssue(issue, pr, success) {
    const [owner, repo] = GITHUB_REPO.split('/');

    const newLabel = success ? 'agent-complete' : 'agent-failed';

    await github('DELETE',
        `/repos/${owner}/${repo}/issues/${issue.number}/labels/in-progress`
    );

    await github('DELETE',
        `/repos/${owner}/${repo}/issues/${issue.number}/labels/${ISSUE_LABEL}`
    );

    await github('POST',
        `/repos/${owner}/${repo}/issues/${issue.number}/labels`,
        { labels: [newLabel] }
    );

    const message = success && pr
        ? `✅ Agent completed work on this issue.\n\nPull request: #${pr.number}`
        : `❌ Agent encountered an error while working on this issue.`;

    await github('POST',
        `/repos/${owner}/${repo}/issues/${issue.number}/comments`,
        { body: message }
    );
}

/**
 * Process a single issue
 */
async function processIssue(issue) {
    currentIssue = issue;
    log(`\n${'═'.repeat(70)}`);
    log(`📋 Processing issue #${issue.number}: ${issue.title}`);
    log(`${'═'.repeat(70)}`);

    try {
        const claimed = await claimIssue(issue);
        if (!claimed) {
            log('Failed to claim issue, skipping...');
            currentIssue = null;
            return false;
        }

        const branchName = await createWorkingBranch(issue);
        log(`Working on branch: ${branchName}`);

        const existingPR = await findExistingPR(issue);
        const result = await runClaude(issue, branchName);

        let hasChanges = false;
        try {
            const status = execSync('git status --porcelain', { cwd: PROJECT_DIR }).toString();
            hasChanges = status.trim().length > 0;

            if (hasChanges) {
                execSync('git add -A', { cwd: PROJECT_DIR });
                execSync(`git commit -m "Address issue #${issue.number}" --allow-empty`, { cwd: PROJECT_DIR });
            }

            const commits = execSync(`git log ${GITHUB_BRANCH}..HEAD --oneline`, { cwd: PROJECT_DIR }).toString();
            hasChanges = commits.trim().length > 0;
        } catch {
            hasChanges = false;
        }

        let pr = existingPR;
        if (hasChanges && result.success) {
            if (existingPR) {
                log(`Updating existing PR #${existingPR.number}`);
                const [owner, repo] = GITHUB_REPO.split('/');
                await github('POST',
                    `/repos/${owner}/${repo}/issues/${existingPR.number}/comments`,
                    {
                        body: `🔧 Agent fixed issues in this PR.\n\n${result.output || 'Updated code and fixed failing checks.'}`
                    }
                );
            } else {
                pr = await createPullRequest(issue, branchName, result.output);
                if (pr) {
                    log(`✅ Created PR #${pr.number}`);
                }
            }
        }

        await completeIssue(issue, pr, result.success && (pr || !hasChanges));

        issuesProcessed++;
        log(`✅ Completed issue #${issue.number}`);

        execSync('git reset --hard HEAD && git clean -fd', { cwd: PROJECT_DIR, stdio: 'pipe' });
        execSync(`git checkout ${GITHUB_BRANCH}`, { cwd: PROJECT_DIR, stdio: 'inherit' });

        currentIssue = null;
        return true;

    } catch (err) {
        log(`❌ Error processing issue #${issue.number}: ${err.message}`);

        try {
            await completeIssue(issue, null, false);
            execSync('git reset --hard HEAD && git clean -fd', { cwd: PROJECT_DIR, stdio: 'pipe' });
            execSync(`git checkout ${GITHUB_BRANCH}`, { cwd: PROJECT_DIR, stdio: 'pipe' });
        } catch {}

        currentIssue = null;
        return false;
    }
}

/**
 * Main polling loop with Phase-Based workflow
 */
async function pollForIssues() {
    // Check if we're rate limited
    if (Date.now() < rateLimitedUntil) {
        const minutesLeft = Math.ceil((rateLimitedUntil - Date.now()) / 60000);
        log(`⏸️  Rate limited, sleeping for ${minutesLeft} more minute(s)...`);
        setTimeout(pollForIssues, Math.min(5 * 60 * 1000, rateLimitedUntil - Date.now())); // Check again in 5 min or when limit expires
        return;
    }

    // PHASE 1: Maintenance - Check and fix my PRs
    const problems = await checkMyPRs();

    if (problems.failing.length > 0 || problems.conflicts.length > 0 || problems.stale.length > 0) {
        await fixMyPRs(problems);
        // After fixing, loop back to check again
        const jitter = Math.random() * 5000;
        await sleep(jitter);
        setImmediate(pollForIssues);
        return;
    }

    // PHASE 2: Check work limits
    if (problems.count >= MAX_OPEN_PRS) {
        log(`⏸️  At PR limit (${problems.count}/${MAX_OPEN_PRS}), waiting for merges...`);
        const jitter = Math.random() * 10000;
        setTimeout(pollForIssues, POLL_INTERVAL + jitter);
        return;
    }

    // PHASE 3: Create - Find new issues
    log('🔍 PHASE 3: Looking for new issues to claim...');
    const issue = await findAvailableIssue();

    if (issue) {
        await processIssue(issue);
        const jitter = Math.random() * 5000;
        await sleep(jitter);
        setImmediate(pollForIssues);
    } else {
        log('ℹ️  No unclaimed issues available');
        const jitter = Math.random() * 10000;
        setTimeout(pollForIssues, POLL_INTERVAL + jitter);
    }
}

/**
 * Display startup banner
 */
function showBanner() {
    console.log('');
    console.log('╔══════════════════════════════════════════════════════════════════════╗');
    console.log('║              Claude Issue Worker (Phase-Based Workflow)              ║');
    console.log('╠══════════════════════════════════════════════════════════════════════╣');
    console.log(`║  Worker ID:       ${WORKER_ID.padEnd(48)} ║`);
    console.log(`║  Repository:      ${(GITHUB_REPO || 'NOT SET').padEnd(48)} ║`);
    console.log(`║  Branch:          ${GITHUB_BRANCH.padEnd(48)} ║`);
    console.log(`║  Issue Label:     ${ISSUE_LABEL.padEnd(48)} ║`);
    console.log(`║  Poll Interval:   ${(POLL_INTERVAL/1000 + 's').padEnd(48)} ║`);
    console.log(`║  Max Open PRs:    ${MAX_OPEN_PRS.toString().padEnd(48)} ║`);
    console.log(`║  Auto-Fix:        Conflicts=${AUTO_FIX_CONFLICTS}, GoMod=${AUTO_FIX_GO_MOD}, PreCommit=${AUTO_FIX_PRECOMMIT}`.padEnd(71) + ' ║');
    console.log('╠══════════════════════════════════════════════════════════════════════╣');
    console.log('║  Phase 1: MAINTAIN - Fix your broken PRs first                       ║');
    console.log('║  Phase 2: CREATE - Only claim new issues when healthy                ║');
    console.log('╚══════════════════════════════════════════════════════════════════════╝');
    console.log('');
}

/**
 * Handle graceful shutdown
 */
function setupShutdown() {
    const shutdown = (signal) => {
        log('');
        log(`📊 Worker Statistics`);
        log(`   Issues processed:    ${issuesProcessed}`);
        log(`   PRs fixed:           ${prsFixed}`);
        log(`   Conflicts resolved:  ${conflictsResolved}`);
        log(`   Current issue:       ${currentIssue ? `#${currentIssue.number}` : 'none'}`);
        log(`\n👋 Received ${signal}, shutting down...`);
        process.exit(0);
    };

    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/**
 * Validate configuration
 */
function validateConfig() {
    const errors = [];

    if (!GITHUB_REPO) errors.push('GITHUB_REPO is required');
    if (!GITHUB_APP_ID) errors.push('GITHUB_APP_ID is required');
    if (!GITHUB_APP_INSTALLATION_ID) errors.push('GITHUB_APP_INSTALLATION_ID is required');
    if (!GITHUB_APP_PRIVATE_KEY && !GITHUB_APP_PRIVATE_KEY_PATH) {
        errors.push('GITHUB_APP_PRIVATE_KEY or GITHUB_APP_PRIVATE_KEY_PATH is required');
    }

    if (errors.length > 0) {
        console.error('Configuration errors:');
        errors.forEach(e => console.error(`  - ${e}`));
        process.exit(1);
    }
}

/**
 * Main entry point
 */
async function main() {
    showBanner();
    validateConfig();
    setupShutdown();

    await ensureRepoCloned();

    const startupJitter = Math.random() * 15000;
    log(`⏳ Starting in ${(startupJitter/1000).toFixed(1)}s (stagger delay)`);
    log(`   Phase-based workflow enabled`);
    log(`   Priority: Fix my PRs → Claim new issues`);

    await sleep(startupJitter);

    pollForIssues();
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
