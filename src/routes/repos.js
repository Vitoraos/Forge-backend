import { encrypt } from '../services/crypto.js'
import { createGithubClient } from '../services/github.js'
import { manualReIndex } from '../services/indexer.js'

const GITHUB_API = 'https://api.github.com'

function createError(message, code = 'INTERNAL_ERROR', statusCode = 500, details = null) {
  const err = { error: message, code }
  if (details) err.details = details
  return err
}

// ─── VALIDATION HELPERS (SSRF Defense) ───────────────────────────

/**
 * Validates a GitHub repository URL and returns the owner/repo slug.
 * Prevents SSRF by rejecting URLs with unexpected paths, query params,
 * fragments, or usernames.
 */
function parseGitHubRepoUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    throw new Error('URL is required')
  }

  let parsed
  try {
    parsed = new URL(urlString)
  } catch {
    throw new Error('Invalid URL format')
  }

  // Must be https://github.com/owner/repo
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com') {
    throw new Error('URL must be a valid GitHub repository URL (https://github.com/owner/repo)')
  }

  // Reject URLs with query strings or fragments (could be used for injection)
  if (parsed.search || parsed.hash) {
    throw new Error('URL must not contain query parameters or fragments')
  }

  // Extract owner/repo from pathname
  const path = parsed.pathname.replace(/^\/+/, '').replace(/\/+$/, '')
  const parts = path.split('/').filter(Boolean)

  if (parts.length !== 2) {
    throw new Error('URL path must be in the format /owner/repo')
  }

  const [owner, repo] = parts

  // GitHub username rules (simplified but strict)
  if (!/^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(owner) || /--/.test(owner)) {
    throw new Error(`Invalid GitHub owner name: "${owner}"`)
  }

  // GitHub repo name rules
  if (!/^[a-zA-Z0-9._-]{1,100}$/.test(repo)) {
    throw new Error(`Invalid GitHub repository name: "${repo}"`)
  }

  return { owner, repo, slug: `${owner}/${repo}` }
}

/**
 * Safely builds a GitHub API URL for a repo endpoint.
 * Every path segment is individually encoded.
 */
function buildRepoApiUrl(owner, repo, ...pathSegments) {
  const url = new URL(`${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`)
  for (const seg of pathSegments) {
    if (seg !== '' && seg !== null && seg !== undefined) {
      url.pathname += '/' + encodeURIComponent(seg)
    }
  }
  return url
}

/**
 * Validates a repo slug in owner/repo format.
 */
function validateRepoSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new Error('Repository slug is required')
  }
  const parts = slug.split('/')
  if (parts.length !== 2) {
    throw new Error(`repo must be "owner/repo", got "${slug}"`)
  }
  return parseGitHubRepoUrl(`https://github.com/${slug}`)
}

export default async function reposRoutes(fastify) {
  const supabase = fastify.supabase

  // ─── DETECT SOURCE ROOTS ─────────────────────────────────────────
  fastify.post('/repos/detect-roots', async (req, reply) => {
    const { url, github_pat } = req.body
    if (!url || !github_pat) {
      return reply.status(400).send(createError('Missing url or github_pat', 'MISSING_FIELD', 400))
    }

    let owner, repo, slug
    try {
      ;({ owner, repo, slug } = parseGitHubRepoUrl(url))
    } catch (err) {
      return reply.status(400).send(createError(err.message, 'INVALID_URL', 400))
    }

    const github = createGithubClient(github_pat, slug)
    try {
      const tree = await github.getRepoTree()
      const topDirs = tree
        .filter(f => f.type === 'tree' && !f.path.includes('/'))
        .map(f => f.path)
      const pkgPaths = tree
        .filter(f => f.path.endsWith('package.json'))
        .map(f => f.path.replace('/package.json', ''))
        .filter(p => p !== '')
      return reply.send({
        repo: slug,
        top_level_directories: topDirs,
        detected_package_json_roots: pkgPaths.length ? pkgPaths : ['(root)']
      })
    } catch (err) {
      return reply.status(500).send(createError(err.message, 'GITHUB_ERROR'))
    }
  })

  // ─── CREATE REPO ─────────────────────────────────────────────────
  fastify.post('/repos', async (req, reply) => {
    const { name, url, github_pat, default_branch, source_root } = req.body
    const owner_id = req.user.id

    if (!name || !url || !github_pat) {
      return reply.status(400).send(createError('Missing required fields', 'MISSING_FIELD', 400))
    }
    if (name.length > 100) {
      return reply.status(400).send(createError('Name must be 100 characters or less', 'VALIDATION_FAILED', 400))
    }

    let owner, repo, slug
    try {
      ;({ owner, repo, slug } = parseGitHubRepoUrl(url))
    } catch (err) {
      return reply.status(400).send(createError(err.message, 'INVALID_URL', 400))
    }

    // Validate we can reach the repo via GitHub API using a safely-built URL
    try {
      const validateUrl = buildRepoApiUrl(owner, repo)
      const validateRes = await fetch(validateUrl, {
        headers: {
          Authorization: `Bearer ${github_pat}`,
          Accept: 'application/vnd.github+json'
        }
      })
      if (!validateRes.ok) {
        return reply.status(400).send(createError('Cannot access repository. Check the URL and PAT permissions.', 'GITHUB_AUTH_ERROR', 400))
      }
    } catch (err) {
      return reply.status(400).send(createError('Failed to validate repository access', 'GITHUB_ERROR', 400))
    }

    const encrypted_pat = encrypt(github_pat)
    const { data, error } = await supabase
      .from('repos')
      .insert({
        name,
        url,
        github_pat: encrypted_pat,
        default_branch: default_branch || 'main',
        owner_id,
        index_status: 'pending',
        file_count: 0,
        source_root: source_root || null
      })
      .select()
      .single()

    if (error) return reply.status(500).send(createError(error.message, 'DB_ERROR'))

    try {
      await triggerIndexWorkflow(slug, data.id, github_pat, source_root)
      console.log(`Indexing triggered for ${slug} (root: ${source_root || 'repo root'})`)
    } catch (err) {
      console.error(`Failed to trigger indexing: ${err.message}`)
      return reply.status(500).send({
        error: 'Repo saved, but indexing failed to start',
        code: 'WORKFLOW_FAILED',
        detail: err.message
      })
    }

    const { github_pat: _, ...safeRepo } = data
    return reply.send({ ok: true, repo: safeRepo })
  })

  // ─── LIST REPOS ──────────────────────────────────────────────────
  fastify.get('/repos', async (req, reply) => {
    const owner_id = req.user.id
    const { page = '1', limit = '20' } = req.query

    const pageNum = Math.max(1, parseInt(page, 10) || 1)
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20))
    const offset = (pageNum - 1) * limitNum

    const { data, error, count } = await supabase
      .from('repos')
      .select('id, name, url, default_branch, index_status, file_count, source_root, created_at', { count: 'exact' })
      .eq('owner_id', owner_id)
      .order('created_at', { ascending: false })
      .range(offset, offset + limitNum - 1)

    if (error) return reply.status(500).send(createError(error.message, 'DB_ERROR'))
    return reply.send({
      repos: data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count || 0,
        totalPages: Math.ceil((count || 0) / limitNum)
      }
    })
  })

  // ─── IMPACT PREVIEW ──────────────────────────────────────────────
  fastify.get('/repos/:id/impact-preview', async (req, reply) => {
    const owner_id = req.user.id
    const repoId = parseInt(req.params.id, 10)
    const q = (req.query.q || '').trim()

    if (!repoId) {
      return reply.status(400).send(createError('Invalid repo ID', 'VALIDATION_FAILED', 400))
    }

    const { data: repo } = await supabase
      .from('repos')
      .select('id')
      .eq('id', repoId)
      .eq('owner_id', owner_id)
      .single()

    if (!repo) {
      return reply.status(403).send(createError('Repo not found or unauthorized', 'FORBIDDEN', 403))
    }

    if (!q) {
      return reply.send({ files: [] })
    }

    const { data: files, error } = await supabase
      .from('files')
      .select('path, language')
      .eq('repo_id', repoId)
      .limit(500)

    if (error) {
      return reply.status(500).send(createError(error.message, 'DB_ERROR'))
    }

    const keywords = q.toLowerCase().split(/\
