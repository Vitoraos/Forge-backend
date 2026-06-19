// github.js
// All GitHub API interactions go through this module.
// Throws Error with human-readable messages on every non-OK status.

const GITHUB_API = 'https://api.github.com'

// ─── VALIDATION HELPERS ────────────────────────────────────────

/**
 * Checks that a value is a non-empty string.
 */
function requireString(value, name) {
  if (!value || typeof value !== 'string') {
    throw new Error(`${name} is required and must be a non-empty string`)
  }
  return value
}

/**
 * Validates a GitHub repo identifier (owner/repo).
 * Only allows letters, numbers, hyphens, underscores, and dots.
 */
function validateRepo(repo) {
  requireString(repo, 'repo')

  const parts = repo.split('/')
  if (parts.length !== 2) {
    throw new Error(`repo must be "owner/repo", got "${repo}"`)
  }

  const [owner, name] = parts

  // GitHub usernames: 1-39 chars, alphanumeric and hyphens only
  // (no underscores, no dots, no leading/trailing hyphens, no consecutive hyphens)
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(owner)) {
    throw new Error(`Invalid GitHub owner: "${owner}"`)
  }
  if (/--/.test(owner)) {
    throw new Error(`Invalid GitHub owner: consecutive hyphens in "${owner}"`)
  }

  // GitHub repo names: 1-100 chars, alphanumeric + . - _
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(name)) {
    throw new Error(`Invalid GitHub repo name: "${name}"`)
  }

  return { owner, name }
}

/**
 * Validates a branch name to prevent URL injection.
 */
function validateBranch(name) {
  requireString(name, 'branch name')
  if (name.length > 255) {
    throw new Error('branch name exceeds 255 characters')
  }
  // Disallow control chars, backslash, and path traversal
  if (/[\x00-\x1f\x7f\\]/.test(name) || name.includes('..')) {
    throw new Error(`Invalid branch name: "${name}"`)
  }
  return name
}

/**
 * Validates a file path to prevent directory traversal.
 */
function validatePath(path) {
  if (path === null || path === undefined) return ''
  requireString(path, 'path')
  // Remove leading slashes
  const clean = path.replace(/^\/+/, '')
  // Block path traversal
  if (clean.includes('..') || clean.includes('\x00')) {
    throw new Error(`Invalid file path: "${path}"`)
  }
  return clean
}

/**
 * Safely builds a GitHub API URL by encoding every path segment.
 */
function buildUrl(basePath, ...segments) {
  const url = new URL(GITHUB_API)
  let path = basePath
  for (const seg of segments) {
    if (seg !== '' && seg !== null && seg !== undefined) {
      path += '/' + encodeURIComponent(seg)
    }
  }
  url.pathname = path
  return url
}

export function createGithubClient(pat, repo) {
  requireString(pat, 'pat')

  // Validate repo and build the safe base URL
  const { owner, name } = validateRepo(repo)
  const basePath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`

  const headers = {
    Authorization: `Bearer ${pat}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'X-GitHub-Api-Version': '2022-11-28'
  }

  // ─── INTERNAL FETCH WITH RATE LIMIT TRACKING ─────────────────
  async function ghFetch(url, options = {}) {
    const urlObj = url instanceof URL ? url : new URL(url)

    // SECURITY: Only allow requests to the official GitHub API
    const allowed = new URL(GITHUB_API)
    if (urlObj.origin !== allowed.origin) {
      throw new Error(`Blocked request to unauthorized origin: ${urlObj.origin}`)
    }

    const res = await fetch(urlObj, {
      ...options,
      headers: { ...headers, ...(options.headers || {}) }
    })

    const remaining = res.headers.get('X-RateLimit-Remaining')
    const resetAt = res.headers.get('X-RateLimit-Reset')
    if (remaining && parseInt(remaining) < 10) {
      console.warn(`GitHub rate limit low: ${remaining} remaining, resets at ${new Date(resetAt * 1000).toISOString()}`)
    }

    return res
  }

  function handleStatus(res, context) {
    if (res.status === 401) throw new Error(`GitHub 401 on ${context}: PAT is invalid or expired. Re-save your GitHub token in settings.`)
    if (res.status === 403) throw new Error(`GitHub 403 on ${context}: PAT lacks the required scope. Ensure it has 'repo' (or 'contents:write') access.`)
    if (res.status === 404) throw new Error(`GitHub 404 on ${context}: resource not found. Check the repository URL and PAT access.`)
    if (res.status === 422) throw new Error(`GitHub 422 on ${context}: validation failed (branch may already exist or SHA conflict).`)
    if (res.status === 409) throw new Error(`GitHub 409 on ${context}: SHA conflict — the file was modified remotely between fetch and push. Please retry.`)
    if (!res.ok) throw new Error(`GitHub ${res.status} on ${context}`)
  }

  // ─── DEFAULT BRANCH (cached per client instance) ───────────────
  let _defaultBranch = null
  async function getDefaultBranch() {
    if (_defaultBranch) return _defaultBranch
    const res = await ghFetch(buildUrl(basePath))
    handleStatus(res, 'getDefaultBranch')
    const data = await res.json()
    _defaultBranch = data.default_branch
    if (!_defaultBranch) throw new Error('GitHub repo response missing default_branch field')
    return _defaultBranch
  }

  // ─── REPO FILE TREE ────────────────────────────────────────────
  async function getRepoTree() {
    const branch = validateBranch(await getDefaultBranch())
    const url = buildUrl(basePath, 'git', 'trees', branch)
    url.searchParams.set('recursive', '1')
    const res = await ghFetch(url)
    handleStatus(res, 'getRepoTree')
    const data = await res.json()
    if (data.truncated) {
      throw new Error(
        'GitHub tree response was truncated (repo has > 100,000 entries). ' +
        'Set SOURCE_ROOT to a subdirectory to reduce scope, or split the repo.'
      )
    }
    return (data.tree || []).filter(f => f.type === 'blob')
  }

  // ─── FILE CONTENT ──────────────────────────────────────────────
  async function getFileContent(path, branchName = null) {
    const cleanPath = validatePath(path)
    const url = buildUrl(basePath, 'contents', ...cleanPath.split('/').filter(Boolean))
    if (branchName) {
      url.searchParams.set('ref', validateBranch(branchName))
    }
    const res = await ghFetch(url)
    if (res.status === 404) return null
    handleStatus(res, `getFileContent(${cleanPath})`)
    const data = await res.json()
    if (Array.isArray(data)) throw new Error(`Path ${cleanPath} is a directory, not a file`)
    if (!data.content) throw new Error(`GitHub response for ${cleanPath} missing content field`)
    return Buffer.from(data.content, 'base64').toString('utf8')
  }

  // ─── FILE SHA ──────────────────────────────────────────────────
  async function getFileSha(path, branchName = null) {
    const cleanPath = validatePath(path)
    const url = buildUrl(basePath, 'contents', ...cleanPath.split('/').filter(Boolean))
    if (branchName) {
      url.searchParams.set('ref', validateBranch(branchName))
    }
    const res = await ghFetch(url)
    if (res.status === 404) return null
    handleStatus(res, `getFileSha(${cleanPath})`)
    const data = await res.json()
    return data.sha || null
  }

  // ─── PUSH FILE ─────────────────────────────────────────────────
  async function pushFile(path, content, message, branch) {
    const cleanPath = validatePath(path)
    validateBranch(branch)
    const sha = await getFileSha(cleanPath, branch)

    const body = {
      message,
      content: Buffer.from(content).toString('base64'),
      branch,
      ...(sha ? { sha } : {})
    }

    const url = buildUrl(basePath, 'contents', ...cleanPath.split('/').filter(Boolean))
    const res = await ghFetch(url, {
      method: 'PUT',
      body: JSON.stringify(body)
    })

    if (res.status === 409) {
      throw new Error(
        `SHA conflict pushing ${cleanPath}: the file was modified remotely between fetch and push. ` +
        'The draft is preserved. Please re-approve to retry with the current SHA.'
      )
    }
    handleStatus(res, `pushFile(${cleanPath})`)
    return res.json()
  }

  // ─── CREATE BRANCH ─────────────────────────────────────────────
  async function createBranch(branchName) {
    validateBranch(branchName)
    const defaultBranch = validateBranch(await getDefaultBranch())

    const refUrl = buildUrl(basePath, 'git', 'ref', 'heads', defaultBranch)
    const refRes = await ghFetch(refUrl)
    handleStatus(refRes, `getRef(${defaultBranch})`)
    const refData = await refRes.json()
    const sha = refData.object?.sha
    if (!sha) throw new Error('GitHub ref response missing SHA')

    const createUrl = buildUrl(basePath, 'git', 'refs')
    const res = await ghFetch(createUrl, {
      method: 'POST',
      body: JSON.stringify({ ref: `refs/heads/${branchName}`, sha })
    })

    if (res.status === 422) return true // Branch already exists — idempotent
    handleStatus(res, `createBranch(${branchName})`)
    return true
  }

  // ─── ENSURE BRANCH AND PUSH (atomic helper) ──────────────────
  async function ensureBranchAndPush(branchName, filePath, content, message) {
    validateBranch(branchName)
    try {
      await createBranch(branchName)
    } catch (err) {
      if (!err.message.includes('already exists')) throw err
    }

    let sha = null
    try {
      sha = await getFileSha(filePath, branchName)
    } catch (e) {
      // File doesn't exist on branch
    }

    return pushFile(filePath, content, message, branchName)
  }

  return {
    getDefaultBranch,
    getRepoTree,
    getFileContent,
    getFileSha,
    pushFile,
    createBranch,
    ensureBranchAndPush
  }
}
