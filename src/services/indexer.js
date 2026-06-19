// src/services/indexer.js
// SHA-based incremental re-indexing
// Polls all repos every 15 minutes and triggers re-index when the default branch SHA changes

import { createGithubClient } from './github.js'
import { decrypt } from './crypto.js'

const GITHUB_API = 'https://api.github.com'

// --- Validation Helpers ---

/**
 * Validates that a string is a legitimate GitHub repository URL
 */
function validateGitHubUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('Invalid repository URL')
  }
  // Must be https://github.com/owner/repo[.git][/]
  const githubUrlRegex = /^https:\/\/github\.com\/[a-zA-Z0-9-]+\/[a-zA-Z0-9._-]+(?:\.git)?\/?$/
  if (!githubUrlRegex.test(urlString)) {
    throw new Error('Repository URL must be a valid GitHub URL (https://github.com/owner/repo)')
  }
}

/**
 * Validates and decomposes a repo slug into encoded owner/repo segments
 * @returns {{ owner: string, repo: string, encodedUrl: string }}
 */
function parseRepoSlug(repoIdentifier, branch) {
  if (!repoIdentifier || typeof repoIdentifier !== 'string') {
    throw new Error('Invalid repository identifier')
  }

  // Remove .git suffix if present
  const clean = repoIdentifier.replace(/\.git$/, '')

  // Must be exactly owner/repo with allowed GitHub characters
  const slugRegex = /^[a-zA-Z0-9-]{1,39}\/[a-zA-Z0-9._-]{1,100}$/
  if (!slugRegex.test(clean)) {
    throw new Error(`Invalid repository slug: ${repoIdentifier}. Expected format: owner/repo`)
  }

  const [owner, repo] = clean.split('/')

  // GitHub usernames cannot start/end with hyphen or contain consecutive hyphens
  if (/--/.test(owner) || /^-|-$/.test(owner)) {
    throw new Error(`Invalid GitHub owner name: ${owner}`)
  }

  // Validate branch name
  if (!branch || typeof branch !== 'string' || branch.length > 255 || /[\x00-\x1f\x7f]/.test(branch)) {
    throw new Error('Invalid branch name')
  }

  // Build URL safely with encoded path segments
  const url = new URL(
    `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/ref/heads/${encodeURIComponent(branch)}`
  )

  return { owner, repo, encodedUrl: url.toString() }
}

// --- Core Functions ---

/**
 * Check all repos for changes and trigger re-index if SHA changed
 * @param {object} supabase - Supabase client
 */
export async function checkAllReposForChanges(supabase) {
  const { data: repos, error } = await supabase
    .from('repos')
    .select('id, name, url, github_pat, default_branch, last_indexed_sha, index_status, source_root')
    .eq('index_status', 'indexed')

  if (error) {
    console.error('Failed to load repos for change detection:', error.message)
    return { checked: 0, updated: 0, errors: 1 }
  }

  if (!repos || repos.length === 0) {
    console.log('No indexed repos to check for changes')
    return { checked: 0, updated: 0, errors: 0 }
  }

  let updatedCount = 0
  let errorCount = 0

  for (const repo of repos) {
    try {
      const changed = await checkRepoForChanges(supabase, repo)
      if (changed) updatedCount++
    } catch (err) {
      console.error(`Change check failed for repo ${repo.id} (${repo.name}):`, err.message)
      errorCount++
    }
  }

  console.log(`🔍 Change detection complete: ${repos.length} checked, ${updatedCount} changed, ${errorCount} errors`)
  return { checked: repos.length, updated: updatedCount, errors: errorCount }
}

/**
 * Check a single repo for changes
 * @param {object} supabase - Supabase client
 * @param {object} repo - Repo record from DB
 * @returns {boolean} - true if re-index was triggered
 */
export async function checkRepoForChanges(supabase, repo) {
  if (!repo.github_pat) {
    console.warn(`Repo ${repo.id} has no PAT, skipping change check`)
    return false
  }

  // Decrypt PAT
  const pat = decrypt(repo.github_pat)

  // Derive owner/repo from URL with strict validation
  let repoSlug = repo.name
  try {
    validateGitHubUrl(repo.url)
    const url = new URL(repo.url)
    const path = url.pathname.replace(/^\/+/, '').replace(/\.git$/, '')
    if (path.includes('/')) repoSlug = path
  } catch (err) {
    console.warn(`Invalid GitHub URL for repo ${repo.id}: ${repo.url}. Falling back to repo name.`)
    // Continue with repo.name — it will be validated in getBranchSha
  }

  const github = createGithubClient(pat, repoSlug)
  const branch = repo.default_branch || 'main'

  // Get latest commit SHA for default branch
  const latestSha = await getBranchSha(pat, repoSlug, branch)
  if (!latestSha) {
    console.warn(`Could not get SHA for ${repoSlug}/${branch}`)
    return false
  }

  // Compare with stored SHA
  if (latestSha === repo.last_indexed_sha) {
    return false
  }

  console.log(`📦 Repo ${repo.id} (${repoSlug}) changed: ${repo.last_indexed_sha?.slice(0, 7)} → ${latestSha.slice(0, 7)}`)

  // Trigger re-index
  await triggerReIndex(supabase, repo, pat, latestSha)
  return true
}

/**
 * Get the latest commit SHA for a branch via GitHub API
 */
async function getBranchSha(pat, repo, branch) {
  // Validate inputs and build safe URL
  const { encodedUrl } = parseRepoSlug(repo, branch)

  const res = await fetch(encodedUrl, {
    headers: {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json'
    }
  })

  if (!res.ok) {
    if (res.status === 404) {
      console.warn(`Branch ${branch} not found in ${repo}`)
      return null
    }
    throw new Error(`GitHub ${res.status} getting branch SHA`)
  }

  const data = await res.json()
  return data.object?.sha || null
}

/**
 * Trigger re-indexing workflow and update stored SHA
 */
async function triggerReIndex(supabase, repo, pat, newSha) {
  await supabase
    .from('repos')
    .update({
      index_status: 'indexing',
      last_indexed_sha: newSha
    })
    .eq('id', repo.id)

  try {
    await triggerIndexWorkflow(repo, pat)
    console.log(`🚀 Re-index triggered for repo ${repo.id}`)
  } catch (err) {
    console.error(`Failed to trigger re-index for repo ${repo.id}:`, err.message)
    await supabase
      .from('repos')
      .update({ index_status: 'indexed' })
      .eq('id', repo.id)
    throw err
  }
}

/**
 * Trigger the GitHub Actions indexer workflow
 */
async function triggerIndexWorkflow(repo, userPat) {
  const indexerRepo = process.env.INDEXER_REPO
  const indexerPat = process.env.INDEXER_PAT
  if (!indexerRepo || !indexerPat) {
    throw new Error('INDEXER_REPO or INDEXER_PAT not set')
  }

  // Validate that the repo URL is actually a GitHub URL before extracting target
  validateGitHubUrl(repo.url)
  const targetRepo = repo.url.replace('https://github.com/', '').replace(/\/$/, '')

  const res = await fetch(
    `https://api.github.com/repos/${indexerRepo}/actions/workflows/on-demand-index.yml/dispatches`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${indexerPat}`,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          target_repo: targetRepo,
          repo_id: String(repo.id),
          pat_token: userPat,
          source_root: repo.source_root || ''
        }
      })
    }
  )

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Workflow dispatch failed: ${err}`)
  }
}

/**
 * Mark a repo as successfully indexed
 */
export async function markRepoIndexed(supabase, repoId, sha) {
  const { error } = await supabase
    .from('repos')
    .update({
      index_status: 'indexed',
      last_indexed_sha: sha,
      last_indexed_at: new Date().toISOString()
    })
    .eq('id', repoId)

  if (error) {
    console.error(`Failed to mark repo ${repoId} as indexed:`, error.message)
  } else {
    console.log(`✅ Repo ${repoId} marked as indexed at SHA ${sha.slice(0, 7)}`)
  }
}

/**
 * Manual re-index trigger for a specific repo
 */
export async function manualReIndex(supabase, repoId, userId) {
  const { data: repo, error } = await supabase
    .from('repos')
    .select('id, name, url, github_pat, default_branch, source_root, owner_id')
    .eq('id', repoId)
    .eq('owner_id', userId)
    .single()

  if (error || !repo) {
    throw new Error('Repo not found or unauthorized')
  }

  const pat = decrypt(repo.github_pat)
  const branch = repo.default_branch || 'main'

  // Validate the repo identifier before use
  const { encodedUrl } = parseRepoSlug(repo.name, branch)

  // We don't need the URL here, but parseRepoSlug validates the format
  const latestSha = await getBranchSha(pat, repo.name, branch)

  if (!latestSha) {
    throw new Error('Could not get latest branch SHA')
  }

  await triggerReIndex(supabase, repo, pat, latestSha)
  return { ok: true, sha: latestSha }
}
