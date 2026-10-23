'use strict';
/**
 * Social layer service (Phase 1): feed, posts, likes, comments, follows,
 * polls, saved posts, social profiles, communities (list/join/leave).
 *
 * SECURITY invariants enforced here (never trust the client):
 *  - account_type / verified are NEVER writable from request payloads.
 *    Only adminSocialRoutes can change them.
 *  - `official` on a post is computed server-side from the AUTHOR's account
 *    (account_type IN college/club AND verified = 1) at creation time.
 *  - Anonymous posts: identity is stripped in the SELECT, never sent to clients.
 *  - Blocked users cannot interact (follow/message) — enforced in service.
 */
const db = require('../config/db');
const { ApiError } = require('../utils/ApiError');
const { notify } = require('../utils/notify');
const reportSvc = require('./reportService');

/** Filter out shielded content from a result set.
  Shielded posts/comments are hidden from public feeds/threads
  (kept for the author and admins). */
async function filterShieldedPosts(rows, user) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => Number(r.id)).filter(Boolean);
  if (!ids.length) return rows;
  const shielded = new Set(
    (await db.execute(
      'SELECT record_id FROM content_shield WHERE table_name = ? AND record_id IN (' + ids.map(() => '?').join(',') + ')',
      ['posts', ...ids]
    ))[0].map((r) => Number(r.record_id))
  );
  return rows.filter((r) => shielded.has(Number(r.id)) ? false : true);
}

async function filterShieldedComments(rows) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => Number(r.id)).filter(Boolean);
  if (!ids.length) return rows;
  const shielded = new Set(
    (await db.execute(
      'SELECT record_id FROM content_shield WHERE table_name = ? AND record_id IN (' + ids.map(() => '?').join(',') + ')',
      ['post_comments', ...ids]
    ))[0].map((r) => Number(r.record_id))
  );
  return rows.filter((r) => !shielded.has(Number(r.id)));
}

const KINDS = ['POST', 'QUESTION', 'POLL'];
const PAGE_SIZE = 10;

/** Author's social identity, used for official-flag + display. */
function isOfficialAccount(u) {
  return !!u && ['college', 'club'].includes(u.account_type) && !!Number(u.verified);
}

/** Reusable author-select that hides anonymous identities at the SQL level. */
const AUTHOR_SELECT = `
  CASE WHEN p.is_anonymous = 1 THEN NULL ELSE p.author_id END AS author_id,
  CASE WHEN p.is_anonymous = 1 THEN 'Anonymous Student' ELSE u.full_name END AS author_name,
  CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.avatar_path END AS author_avatar,
  CASE WHEN p.is_anonymous = 1 THEN 'student' ELSE u.account_type END AS author_account_type,
  CASE WHEN p.is_anonymous = 1 THEN 0 ELSE u.verified END AS author_verified,
  CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.student_id END AS author_student_id,
  CASE WHEN p.is_anonymous = 1 THEN NULL ELSE d.code END AS author_dept,
  CASE WHEN p.is_anonymous = 1 THEN NULL ELSE u.year END AS author_year`;

/** Reactions + comment counts as scalar subqueries (simple, correct, fine at demo scale). */
const COUNT_SELECT = `
  (SELECT COUNT(*) FROM reactions r WHERE r.target_type = 'POST' AND r.target_id = p.id AND r.value = 1) AS like_count,
  (SELECT COUNT(*) FROM reactions r WHERE r.target_type = 'POST' AND r.target_id = p.id AND r.value = -1) AS dislike_count,
  (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comment_count`;

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------
const SORTS = ['latest', 'trending', 'discussed', 'top'];

async function feed(user, { tab = 'foryou', kind = '', communityId = 0, authorId = 0, page = 1, sort = '' } = {}) {
  const p = Math.max(1, parseInt(page, 10) || 1);
  const where = [];
  const params = [];

  const aid = parseInt(authorId, 10) || 0;
  if (aid) {
    // Profile posts: anonymous posts stay hidden unless viewer is the author or ADMIN.
    const canSeeAnon = user && (user.id === aid || user.role === 'ADMIN');
    where.push('p.author_id = ?');
    params.push(aid);
    if (!canSeeAnon) where.push('p.is_anonymous = 0');
  }

  if (tab === 'following') {
    if (!user) throw new ApiError(401, 'Log in to see your Following feed');
    // People you follow, your own posts, and the communities you joined.
    where.push(`(p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?)
      OR p.author_id = ?
      OR p.community_id IN (SELECT community_id FROM community_members WHERE user_id = ?))`);
    params.push(user.id, user.id, user.id);
  } else if (tab === 'official') {
    where.push('p.official = 1');
  } else if (tab === 'trending') {
    // no extra filter; ordering below
  }

  if (kind && KINDS.includes(kind)) {
    where.push('p.kind = ?');
    params.push(kind);
  }
  const cid = parseInt(communityId, 10) || 0;
  if (cid) {
    where.push('p.community_id = ?');
    params.push(cid);
  }

  // Discussion/feed ordering. `tab=trending` keeps its meaning when no explicit sort is sent.
  const effSort = SORTS.includes(sort) ? sort : (tab === 'trending' ? 'trending' : 'latest');
  const order = {
    latest: 'ORDER BY p.created_at DESC',
    // Postgres cannot reference SELECT aliases inside an ORDER BY expression, so the
    // hot score is spelled out with the same subqueries COUNT_SELECT uses.
    trending: `ORDER BY (
        (SELECT COUNT(*) FROM reactions r WHERE r.target_type='POST' AND r.target_id=p.id AND r.value=1) * 2
      + (SELECT COUNT(*) FROM post_comments c WHERE c.post_id=p.id) * 3
      - (SELECT COUNT(*) FROM reactions r WHERE r.target_type='POST' AND r.target_id=p.id AND r.value=-1) * 2
      ) DESC, p.created_at DESC`,
    discussed: 'ORDER BY comment_count DESC, p.created_at DESC',
    top: 'ORDER BY like_count DESC, p.created_at DESC',
  }[effSort];

  const [feedRows] = await db.execute(
    `SELECT p.id, p.kind, p.title, p.content, p.is_anonymous, p.image_path, p.video_path,
            p.poll_question, p.official, p.community_id, p.created_at, c.name AS community_name, c.slug AS community_slug,
            ${AUTHOR_SELECT}, ${COUNT_SELECT},
            ${user ? `(SELECT COUNT(*) FROM reactions r WHERE r.target_type='POST' AND r.target_id=p.id AND r.user_id=? AND r.value=1) > 0` : '0'} AS liked_by_me,
            ${user ? `COALESCE((SELECT MAX(r.value) FROM reactions r WHERE r.target_type='POST' AND r.target_id=p.id AND r.user_id=?), 0) AS my_reaction` : '0 AS my_reaction'},
            ${user ? `(SELECT COUNT(*) FROM saved_posts s WHERE s.post_id=p.id AND s.user_id=?) > 0` : '0'} AS saved_by_me
     FROM posts p
     LEFT JOIN users u ON u.id = p.author_id
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN communities c ON c.id = p.community_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ${order}
     LIMIT ${PAGE_SIZE} OFFSET ${(p - 1) * PAGE_SIZE}`,
    user ? [user.id, user.id, user.id, ...params] : params
  );
  const filteredFeedRows = await filterShieldedPosts(feedRows, user);
  await attachPolls(filteredFeedRows, user);
  return { rows: filteredFeedRows, page: p, sort: effSort, hasMore: filteredFeedRows.length === PAGE_SIZE };
}

async function attachPolls(rows, user) {
  for (const post of rows) {
    if (post.kind !== 'POLL') continue;
    const [opts] = await db.execute(
      `SELECT o.id, o.label, o.position,
              (SELECT COUNT(*) FROM poll_votes v WHERE v.option_id = o.id) AS votes
       FROM poll_options o WHERE o.post_id = ? ORDER BY o.position`,
      [post.id]
    );
    const total = opts.reduce((s, o) => s + Number(o.votes), 0);
    let myVote = null;
    if (user) {
      const [mine] = await db.execute('SELECT option_id FROM poll_votes WHERE post_id = ? AND user_id = ?', [post.id, user.id]);
      myVote = mine.length ? Number(mine[0].option_id) : null;
    }
    post.poll = {
      question: post.poll_question,
      total_votes: total,
      my_vote: myVote,
      revealed: myVote !== null,
      options: opts.map((o) => ({
        id: Number(o.id),
        label: o.label,
        votes: Number(o.votes),
        pct: total ? Math.round((Number(o.votes) * 100) / total) : 0,
      })),
    };
  }
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------
async function createPost(user, payload, files) {
  const kind = KINDS.includes(payload.kind) ? payload.kind : 'POST';
  const content = String(payload.content || '').trim();
  if (!content) throw new ApiError(400, 'Post content is required');
  if (kind === 'QUESTION' && !payload.title) throw new ApiError(400, 'Questions need a title');

  // Harassment safeguard: a user flagged by moderation has their new content
  // automatically held (shielded) instead of published to public feeds.
  const shielded = await reportSvc.isUserShielded(user.id);

  const anon = payload.is_anonymous === 1 || payload.is_anonymous === '1' || payload.is_anonymous === true;
  const official = isOfficialAccount(user) ? 1 : 0; // server-computed, client CANNOT set this

  let communityId = parseInt(payload.community_id, 10) || null;
  if (communityId) {
    const [c] = await db.execute('SELECT id FROM communities WHERE id = ?', [communityId]);
    if (!c.length) communityId = null;
  }

  const imagePath = files && files.image ? `/uploads/posts/${files.image[0].filename}` : null;
  const videoPath = files && files.video ? `/uploads/posts/${files.video[0].filename}` : null;

  // Shielded users: content is stored but hidden from public feeds pending review.
  const autoShield = shielded ? 'MANUAL_PENDING' : null;

  const [r] = await db.execute(
    `INSERT INTO posts (author_id, kind, title, content, is_anonymous, community_id, image_path, video_path, poll_question, official)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [user.id, kind, payload.title || null, content, anon ? 1 : 0, communityId,
     kind === 'POLL' ? null : imagePath, kind === 'POLL' ? null : videoPath,
     kind === 'POLL' ? String(payload.poll_question || '').trim() || 'Poll' : null, official]
  );
  const postId = r.insertId;

  if (autoShield) {
    await reportSvc._shieldPost(postId, autoShield, 'SYSTEM', 'Posted while user was under moderation review.');
  }

  if (kind === 'POLL') {
    const labels = (Array.isArray(payload.poll_options) ? payload.poll_options : [])
      .map((s) => String(s || '').trim()).filter(Boolean).slice(0, 6);
    if (labels.length < 2) throw new ApiError(400, 'Polls need at least 2 options');
    for (let i = 0; i < labels.length; i++) {
      await db.execute('INSERT INTO poll_options (post_id, label, position) VALUES (?, ?, ?)', [postId, labels[i], i]);
    }
  }

  // Notify followers (personalized priority) — skip for anonymous posts.
  if (!anon) {
    const [followers] = await db.execute(
      'SELECT follower_id FROM follows WHERE followee_id = ? LIMIT 200', [user.id]
    );
    for (const f of followers) {
      await notify(db, {
        recipientId: f.follower_id, type: 'SOCIAL',
        title: 'New post', message: `${user.name} posted: ${content.slice(0, 60)}`,
        relatedType: 'POST', relatedId: postId, link: '/feed.html', priority: 1,
        dedupeKey: null,
      });
    }
  }
  return { id: postId };
}

async function getPost(user, id) {
  const baseRows = await db.execute(
    `SELECT p.id, p.kind, p.title, p.content, p.is_anonymous, p.image_path, p.video_path,
            p.poll_question, p.official, p.community_id, p.created_at, c.name AS community_name, c.slug AS community_slug,
            ${AUTHOR_SELECT}, ${COUNT_SELECT},
            ${user ? `(SELECT COUNT(*) FROM reactions r WHERE r.target_type='POST' AND r.target_id=p.id AND r.user_id=? AND r.value=1) > 0` : '0'} AS liked_by_me,
            ${user ? `COALESCE((SELECT MAX(r.value) FROM reactions r WHERE r.target_type='POST' AND r.target_id=p.id AND r.user_id=?), 0) AS my_reaction` : '0 AS my_reaction'},
            ${user ? `(SELECT COUNT(*) FROM saved_posts s WHERE s.post_id=p.id AND s.user_id=?) > 0` : '0'} AS saved_by_me
     FROM posts p
     LEFT JOIN users u ON u.id = p.author_id
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN communities c ON c.id = p.community_id
     WHERE p.id = ?`,
    user ? [user.id, user.id, user.id, id] : [id]
  );
  if (!baseRows[0].length) throw new ApiError(404, 'Post not found');
  const ward = await filterShieldedPosts(baseRows[0], user);
  if (!ward.length) throw new ApiError(404, 'Post not found');
  await attachPolls(ward, user);
  return ward[0];
}

async function deletePost(user, id) {
  const [postRows] = await db.execute('SELECT author_id, official FROM posts WHERE id = ?', [id]);
  if (!postRows.length) throw new ApiError(404, 'Post not found');
  const post = postRows[0];
  const isOwner = Number(post.author_id) === user.id;
  const isStaff = ['ADMIN', 'FACULTY'].includes(user.role);
  if (!isOwner && !isStaff) throw new ApiError(403, 'You can only delete your own posts');
  await db.execute('DELETE FROM posts WHERE id = ?', [id]);
}

/**
 * Edit an existing post (author or staff). Only title/content may change;
 * kind, anonymity, and the server-computed official flag stay as published.
 */
async function updatePost(user, id, payload) {
  const [rows] = await db.execute('SELECT id, author_id, kind FROM posts WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Post not found');
  const post = rows[0];
  const isOwner = Number(post.author_id) === user.id;
  const isStaff = ['ADMIN', 'FACULTY'].includes(user.role);
  if (!isOwner && !isStaff) throw new ApiError(403, 'You can only edit your own posts');
  if (post.kind === 'POLL') throw new ApiError(400, 'Polls cannot be edited after publishing');

  const fields = [];
  const params = [];
  if (payload.content !== undefined) {
    const content = String(payload.content || '').trim();
    if (!content) throw new ApiError(400, 'Post content is required');
    fields.push('content = ?');
    params.push(content);
  }
  if (payload.title !== undefined) {
    if (post.kind === 'QUESTION' && !String(payload.title || '').trim()) throw new ApiError(400, 'Questions need a title');
    fields.push('title = ?');
    params.push(String(payload.title || '').trim() || null);
  }
  if (!fields.length) throw new ApiError(400, 'Nothing to update');
  params.push(id);
  await db.execute(`UPDATE posts SET ${fields.join(', ')} WHERE id = ?`, params);
  return { updated: true };
}

/** Edit a comment (author or staff). Anonymous comments stay anonymous. */
async function updateComment(user, id, payload) {
  const [rows] = await db.execute('SELECT id, author_id FROM post_comments WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Comment not found');
  const isOwner = Number(rows[0].author_id) === user.id;
  if (!isOwner && !['ADMIN', 'FACULTY'].includes(user.role)) throw new ApiError(403, 'You can only edit your own comments');
  const content = String((payload && payload.content) || '').trim();
  if (!content) throw new ApiError(400, 'Comment cannot be empty');
  await db.execute('UPDATE post_comments SET content = ? WHERE id = ?', [content, id]);
  return { updated: true };
}

/** Delete a comment (author or staff); its replies go with it. */
async function deleteComment(user, id) {
  const [rows] = await db.execute('SELECT id, author_id FROM post_comments WHERE id = ?', [id]);
  if (!rows.length) throw new ApiError(404, 'Comment not found');
  const isOwner = Number(rows[0].author_id) === user.id;
  if (!isOwner && !['ADMIN', 'FACULTY'].includes(user.role)) throw new ApiError(403, 'You can only delete your own comments');
  await db.execute('DELETE FROM post_comments WHERE id = ? OR parent_id = ?', [id, id]);
  return { deleted: true };
}

async function react(user, targetType, targetId, value) {
  const type = targetType === 'COMMENT' ? 'COMMENT' : 'POST';
  const tid = parseInt(targetId, 10);
  const val = Number(value) === -1 ? -1 : 1;
  if (type === 'POST') {
    const [ex] = await db.execute('SELECT id FROM posts WHERE id = ?', [tid]);
    if (!ex.length) throw new ApiError(404, 'Post not found');
  } else {
    const [ex] = await db.execute('SELECT id FROM post_comments WHERE id = ?', [tid]);
    if (!ex.length) throw new ApiError(404, 'Comment not found');
  }
  const [existing] = await db.execute(
    'SELECT id, value FROM reactions WHERE user_id = ? AND target_type = ? AND target_id = ?',
    [user.id, type, tid]
  );
  /** Fresh tallies so upvote/downvote UIs never have to guess. */
  const tally = async () => {
    const [tallyRows] = await db.execute(
      `SELECT
         (SELECT COUNT(*) FROM reactions r WHERE r.target_type = ? AND r.target_id = ? AND r.value = 1) AS likes,
         (SELECT COUNT(*) FROM reactions r WHERE r.target_type = ? AND r.target_id = ? AND r.value = -1) AS dislikes,
         COALESCE((SELECT MAX(r.value) FROM reactions r WHERE r.user_id = ? AND r.target_type = ? AND r.target_id = ?), 0) AS my_reaction`,
      [type, tid, type, tid, user.id, type, tid]
    );
    const r = tallyRows[0] || {};
    return {
      likes: Number(r.likes || 0),
      dislikes: Number(r.dislikes || 0),
      my_reaction: Number(r.my_reaction || 0),
    };
  };

  if (existing.length && Number(existing[0].value) === val) {
    await db.execute('DELETE FROM reactions WHERE id = ?', [existing[0].id]); // toggle off
    return { reacted: false, counts: await tally() };
  }
  if (existing.length) {
    await db.execute('UPDATE reactions SET value = ? WHERE id = ?', [val, existing[0].id]);
  } else {
    await db.execute(
      'INSERT INTO reactions (user_id, target_type, target_id, value) VALUES (?, ?, ?, ?)',
      [user.id, type, tid, val]
    );
    if (type === 'POST' && val === 1) {
      const [p] = await db.execute('SELECT author_id, is_anonymous, content FROM posts WHERE id = ?', [tid]);
      if (p.length && !Number(p[0].is_anonymous) && Number(p[0].author_id) !== user.id) {
        await notify(db, {
          recipientId: p[0].author_id, type: 'SOCIAL',
          title: 'New like', message: `${user.name} liked your post`,
          relatedType: 'POST', relatedId: tid, link: '/feed.html', priority: 1,
        });
      }
    }
  }
  return { reacted: true, my_reaction: val, counts: await tally() };
}

async function comment(user, postId, payload) {
  const content = String(payload.content || '').trim();
  if (!content) throw new ApiError(400, 'Comment cannot be empty');
  const [posts] = await db.execute('SELECT id, author_id, is_anonymous FROM posts WHERE id = ?', [postId]);
  if (!posts.length) throw new ApiError(404, 'Post not found');
  const parentId = parseInt(payload.parent_id, 10) || null;
  const anon = payload.is_anonymous === 1 || payload.is_anonymous === '1' || payload.is_anonymous === true;
  const shieldedC = await reportSvc.isUserShielded(user.id);
  const [r] = await db.execute(
    `INSERT INTO post_comments (post_id, author_id, parent_id, content, is_anonymous)
     VALUES (?, ?, ?, ?, ?)`,
    [postId, user.id, parentId, content, anon ? 1 : 0]
  );
  if (shieldedC) {
    await reportSvc._shieldComment(r.insertId, 'MANUAL_PENDING', 'SYSTEM', 'Comment posted while user was under moderation review.');
  }
  if (!anon && Number(posts[0].author_id) !== user.id) {
    await notify(db, {
      recipientId: posts[0].author_id, type: 'SOCIAL',
      title: 'New comment', message: `${user.name} commented on your post`,
      relatedType: 'POST', relatedId: postId, link: '/feed.html', priority: 1,
    });
  }
  return { id: r.insertId };
}

/** Comments with one level of replies; anonymous identities stripped in SQL. */
async function listComments(user, postId) {
  const baseRows = await db.execute(
    `SELECT c.id, c.post_id, c.parent_id, c.content, c.is_anonymous, c.created_at,
            CASE WHEN c.is_anonymous = 1 THEN NULL ELSE c.author_id END AS author_id,
            CASE WHEN c.is_anonymous = 1 THEN 'Anonymous Student' ELSE cu.full_name END AS author_name,
            CASE WHEN c.is_anonymous = 1 THEN NULL ELSE cu.avatar_path END AS author_avatar,
            CASE WHEN c.is_anonymous = 1 THEN 'student' ELSE cu.account_type END AS author_account_type,
            CASE WHEN c.is_anonymous = 1 THEN 0 ELSE cu.verified END AS author_verified,
            (SELECT COUNT(*) FROM reactions r WHERE r.target_type='COMMENT' AND r.target_id=c.id AND r.value=1) AS like_count,
            (SELECT COUNT(*) FROM reactions r WHERE r.target_type='COMMENT' AND r.target_id=c.id AND r.value=-1) AS dislike_count,
            ${user ? `(SELECT COUNT(*) FROM reactions r WHERE r.target_type='COMMENT' AND r.target_id=c.id AND r.user_id=? AND r.value=1) > 0` : '0'} AS liked_by_me
     FROM post_comments c
     LEFT JOIN users cu ON cu.id = c.author_id
     WHERE c.post_id = ?
     ORDER BY c.created_at ASC`,
    user ? [user.id, postId] : [postId]
  );
  const filteredRows = await filterShieldedComments(baseRows[0]);
  const tops = filteredRows.filter((r) => !r.parent_id);
  const replies = filteredRows.filter((r) => r.parent_id);
  tops.forEach((t) => { t.replies = replies.filter((r) => Number(r.parent_id) === Number(t.id)); });
  return tops;
}

async function toggleSave(user, postId) {
  const [ex] = await db.execute('SELECT id FROM saved_posts WHERE user_id = ? AND post_id = ?', [user.id, postId]);
  if (ex.length) {
    await db.execute('DELETE FROM saved_posts WHERE id = ?', [ex[0].id]);
    return { saved: false };
  }
  await db.execute('INSERT INTO saved_posts (user_id, post_id) VALUES (?, ?)', [user.id, postId]);
  return { saved: true };
}

async function votePoll(user, postId, optionId) {
  const oid = parseInt(optionId, 10);
  const pid = parseInt(postId, 10);
  const [opts] = await db.execute('SELECT id FROM poll_options WHERE id = ? AND post_id = ?', [oid, pid]);
  if (!opts.length) throw new ApiError(404, 'Poll option not found');
  await db.execute(
    `INSERT INTO poll_votes (post_id, option_id, user_id) VALUES (?, ?, ?)
     ON CONFLICT (post_id, user_id) DO UPDATE SET option_id = EXCLUDED.option_id`,
    [pid, oid, user.id]
  );
  return getPost(user, pid);
}

async function savedPosts(user) {
  const [savedRows] = await db.execute(
    `SELECT p.id, p.kind, p.title, p.content, p.is_anonymous, p.image_path, p.video_path,
            p.poll_question, p.official, p.community_id, p.created_at, c.name AS community_name, c.slug AS community_slug,
            ${AUTHOR_SELECT}, ${COUNT_SELECT}, 1 AS saved_by_me,
            (SELECT COUNT(*) FROM reactions r WHERE r.target_type='POST' AND r.target_id=p.id AND r.user_id=? AND r.value=1) > 0 AS liked_by_me
     FROM saved_posts s
     JOIN posts p ON p.id = s.post_id
     LEFT JOIN users u ON u.id = p.author_id
     LEFT JOIN departments d ON d.id = u.department_id
     LEFT JOIN communities c ON c.id = p.community_id
     WHERE s.user_id = ?
     ORDER BY s.created_at DESC LIMIT 100`,
    [user.id, user.id]
  );
  await attachPolls(savedRows, user);
  return savedRows;
}

// ---------------------------------------------------------------------------
// Follows
// ---------------------------------------------------------------------------
async function toggleFollow(user, targetUserId) {
  const tid = parseInt(targetUserId, 10);
  if (tid === user.id) throw new ApiError(400, "You can't follow yourself");
  const [tu] = await db.execute('SELECT id, full_name FROM users WHERE id = ? AND is_active = 1', [tid]);
  if (!tu.length) throw new ApiError(404, 'User not found');
  const [ex] = await db.execute('SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?', [user.id, tid]);
  if (ex.length) {
    await db.execute('DELETE FROM follows WHERE id = ?', [ex[0].id]);
    return { following: false };
  }
  await db.execute('INSERT INTO follows (follower_id, followee_id) VALUES (?, ?)', [user.id, tid]);
  await notify(db, {
    recipientId: tid, type: 'SOCIAL', title: 'New follower',
    message: `${user.name} started following you`,
    relatedType: 'USER', relatedId: user.id, link: `/profile.html?id=${user.id}`, priority: 1,
  });
  return { following: true };
}

/** Everyone who follows :user_id. */
async function followersList(viewer, userId, limit = 100) {
  const uid = parseInt(userId, 10);
  const [fRows] = await db.execute(
    `SELECT u.id, u.full_name, u.avatar_path, u.account_type, u.verified, u.bio,
            u.year, u.student_id, d.code AS dept_code,
            (SELECT COUNT(*) FROM follows f2 WHERE f2.followee_id = u.id) AS follower_count,
            ${viewer ? 'EXISTS (SELECT 1 FROM follows f3 WHERE f3.follower_id = ? AND f3.followee_id = u.id)' : 'FALSE'} AS viewer_follows
       FROM follows f
       JOIN users u ON u.id = f.follower_id
       LEFT JOIN departments d ON d.id = u.department_id
      WHERE f.followee_id = ? AND u.is_active = 1
      ORDER BY f.created_at DESC
      LIMIT ${Math.min(200, Math.max(1, parseInt(limit, 10) || 100))}`,
    viewer ? [viewer.id, uid] : [uid]
  );
  return fRows.map((r) => ({ ...r, verified: !!Number(r.verified), viewer_follows: !!r.viewer_follows }));
}

/** Everyone :user_id follows. */
async function followingList(viewer, userId, limit = 100) {
  const uid = parseInt(userId, 10);
  const [fRows] = await db.execute(
    `SELECT u.id, u.full_name, u.avatar_path, u.account_type, u.verified, u.bio,
            u.year, u.student_id, d.code AS dept_code,
            (SELECT COUNT(*) FROM follows f2 WHERE f2.followee_id = u.id) AS follower_count,
            ${viewer ? 'EXISTS (SELECT 1 FROM follows f3 WHERE f3.follower_id = ? AND f3.followee_id = u.id)' : 'FALSE'} AS viewer_follows
       FROM follows f
       JOIN users u ON u.id = f.followee_id
       LEFT JOIN departments d ON d.id = u.department_id
      WHERE f.follower_id = ? AND u.is_active = 1
      ORDER BY f.created_at DESC
      LIMIT ${Math.min(200, Math.max(1, parseInt(limit, 10) || 100))}`,
    viewer ? [viewer.id, uid] : [uid]
  );
  return fRows.map((r) => ({ ...r, verified: !!Number(r.verified), viewer_follows: !!r.viewer_follows }));
}

// ---------------------------------------------------------------------------
// Social profiles
// ---------------------------------------------------------------------------
async function socialProfile(viewer, userId) {
  const uid = parseInt(userId, 10) || (viewer ? viewer.id : 0);
  const [profRows] = await db.execute(
    `SELECT u.id, u.full_name, u.student_id, u.account_type, u.verified, u.bio, u.skills, u.projects,
            u.avatar_path, u.year, u.created_at, d.code AS dept_code, d.name AS dept_name
     FROM users u LEFT JOIN departments d ON d.id = u.department_id WHERE u.id = ?`,
    [uid]
  );
  if (!profRows.length) throw new ApiError(404, 'User not found');
  const prof = profRows[0];
  prof.verified = !!Number(prof.verified);
  const [[{ post_count }]] = await db.execute(
    "SELECT COUNT(*) AS post_count FROM posts WHERE author_id = ? AND is_anonymous = 0", [uid]
  );
  const [[{ follower_count }]] = await db.execute('SELECT COUNT(*) AS follower_count FROM follows WHERE followee_id = ?', [uid]);
  const [[{ following_count }]] = await db.execute('SELECT COUNT(*) AS following_count FROM follows WHERE follower_id = ?', [uid]);
  prof.stats = { posts: Number(post_count), followers: Number(follower_count), following: Number(following_count) };
  prof.is_me = !!viewer && viewer.id === uid;
  prof.viewer_follows = false;
  if (viewer && !prof.is_me) {
    const [f] = await db.execute('SELECT id FROM follows WHERE follower_id = ? AND followee_id = ?', [viewer.id, uid]);
    prof.viewer_follows = f.length > 0;
  }
  return prof;
}

/**
 * Profile completion indicator: a server-computed, honest estimate of how much
 * of a student's social presence is filled in. It does NOT fake live activity —
 * it only reflects fields the student controls (photo, bio, skills, projects,
 * posts, follows).
 */
function profileCompletionScore(prof) {
  const bits = [
    prof.avatar_path ? 1 : 0,        // profile photo
    prof.bio && prof.bio.trim() ? 1 : 0,      // bio
    prof.skills && String(prof.skills).trim() ? 1 : 0,     // skills
    prof.projects && String(prof.projects).trim() ? 1 : 0, // projects
    prof.stats && prof.stats.posts ? 1 : 0,   // at least one non-anonymous post
    prof.stats && prof.stats.following ? 1 : 0,      // follows at least one person
  ];
  const filled = bits.reduce((a, b) => a + b, 0);
  return Math.round((filled / bits.length) * 100);
}

async function profileCompletion(viewer, userId) {
  const uid = parseInt(userId, 10) || (viewer ? viewer.id : 0);
  if (!uid) throw new ApiError(400, 'User id required');
  const prof = await socialProfile(viewer, uid);
  const pct = profileCompletionScore(prof);
  const suggestions = [];
  if (!prof.avatar_path) suggestions.push({ key: 'avatar', label: 'Add a profile photo', done: false });
  if (!prof.bio || !prof.bio.trim()) suggestions.push({ key: 'bio', label: 'Add a short bio', done: false });
  if (!prof.skills || !String(prof.skills).trim()) suggestions.push({ key: 'skills', label: 'Add a few skills', done: false });
  if (!prof.projects || !String(prof.projects).trim()) suggestions.push({ key: 'projects', label: 'Add your projects', done: false });
  if (prof.stats.posts === 0) suggestions.push({ key: 'posts', label: 'Share your first post', done: false });
  if (prof.stats.following === 0) suggestions.push({ key: 'follows', label: 'Follow a few people', done: false });
  return { id: prof.id, full_name: prof.full_name, is_me: prof.is_me, pct, suggestions };
}

async function updateProfile(user, payload, files) {
  const sets = [];
  const params = [];
  if (typeof payload.bio === 'string') { sets.push('bio = ?'); params.push(payload.bio.slice(0, 1000)); }
  if (typeof payload.skills === 'string') { sets.push('skills = ?'); params.push(payload.skills.slice(0, 1000)); }
  if (typeof payload.projects === 'string') { sets.push('projects = ?'); params.push(payload.projects.slice(0, 2000)); }
  if (files && files.avatar) { sets.push('avatar_path = ?'); params.push(`/uploads/avatars/${files.avatar[0].filename}`); }
  if (files && files.cover) { sets.push('cover_path = ?'); params.push(`/uploads/avatars/${files.cover[0].filename}`); }
  if (!sets.length) return;
  params.push(user.id);
  await db.execute(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
}

/** Delete a user's own profile photo or cover photo, and its storage object. */
async function deletePhoto(user, { kind }) {
  if (kind !== 'avatar' && kind !== 'cover') {
    throw new ApiError(400, 'Unknown photo kind. Use avatar or cover.');
  }
  const uid = Number(user.id);
  const [rows] = await db.execute(
    `SELECT id, avatar_path, cover_path FROM users WHERE id = ?`,
    [uid]
  );
  if (!rows.length) throw new ApiError(404, 'User not found');
  const prof = rows[0];
  const pathKey = kind === 'avatar' ? 'avatar_path' : 'cover_path';
  const oldPath = prof[pathKey];
  if (!oldPath) return { deleted: false, path: null };

  const [, fields] = await db.execute(
    `UPDATE users SET ${pathKey} = NULL WHERE id = ?`, [uid]
  );
  if (!fields.affectedRows) throw new ApiError(500, `Failed to clear ${kind} path`);

  const rel = oldPath.replace(/^\/uploads\//, '');
  const objName = `photos/${uid}/${rel}`;
  try {
    await db.execute(
      `DELETE FROM uploads WHERE storage_path = ? AND user_id = ?`, [objName, uid]
    );
  } catch (e) { /* storage table is optional in this deploy */ }

  return { deleted: true, path: oldPath };
}

// ---------------------------------------------------------------------------
// Communities
// ---------------------------------------------------------------------------
async function listCommunities(user) {
  const [commRows] = await db.execute(
    `SELECT c.*,
            (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS member_count,
            (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id) AS post_count,
            ${user ? `(SELECT COUNT(*) FROM community_members m2 WHERE m2.community_id = c.id AND m2.user_id = ?) > 0` : '0'} AS joined
     FROM communities c ORDER BY member_count DESC, c.name ASC`,
    user ? [user.id] : []
  );
  return commRows;
}

async function communityDetail(user, idOrSlug) {
  const key = /^\d+$/.test(String(idOrSlug)) ? Number(idOrSlug) : String(idOrSlug);
  const baseRows = await db.execute(
    `SELECT c.*,
            (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS member_count,
            (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id) AS post_count,
            (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id AND p.kind = 'QUESTION') AS discussion_count,
            (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id AND m.role = 'MODERATOR') AS moderator_count
     FROM communities c WHERE ${typeof key === 'number' ? 'c.id = ?' : 'c.slug = ?'}`,
    [key]
  );
  if (!baseRows[0].length) throw new ApiError(404, 'Community not found');
  const comm = baseRows[0][0];
  comm.joined = false;
  if (user) {
    const [m] = await db.execute('SELECT id FROM community_members WHERE community_id = ? AND user_id = ?', [comm.id, user.id]);
    comm.joined = m.length > 0;
  }
  return comm;
}

/** Members of a community (joined-first is not meaningful; ordered by join recency). */
async function communityMembers(idOrSlug, limit = 60) {
  const comm = await communityDetail(null, idOrSlug);
  const [memberRows] = await db.execute(
    `SELECT u.id, u.full_name, u.avatar_path, u.account_type, u.verified, u.year,
            d.code AS dept_code, m.role AS member_role, m.joined_at
     FROM community_members m
     JOIN users u ON u.id = m.user_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE m.community_id = ?
     ORDER BY (m.role = 'MODERATOR') DESC, m.joined_at ASC
     LIMIT ?`,
    [comm.id, String(Math.min(200, Math.max(1, parseInt(limit, 10) || 60)))]
  );
  return memberRows.map((r) => ({ ...r, verified: !!Number(r.verified) }));
}

/** Toggle "Interested" on an event (separate from registering = "Going"). */
async function toggleEventInterest(user, eventId) {
  const eid = parseInt(eventId, 10);
  const [e] = await db.execute('SELECT id, is_published FROM events WHERE id = ?', [eid]);
  if (!e.length) throw new ApiError(404, 'Event not found');
  const [ex] = await db.execute('SELECT id FROM event_interests WHERE event_id = ? AND user_id = ?', [eid, user.id]);
  let interested;
  if (ex.length) {
    await db.execute('DELETE FROM event_interests WHERE id = ?', [ex[0].id]);
    interested = false;
  } else {
    await db.execute('INSERT INTO event_interests (event_id, user_id) VALUES (?, ?)', [eid, user.id]);
    interested = true;
  }
  const [cnt] = await db.execute('SELECT COUNT(*) AS n FROM event_interests WHERE event_id = ?', [eid]);
  return { interested, interest_count: Number(cnt[0].n) };
}

/** Events attached to a community (via its department or linked club). */
async function communityEvents(idOrSlug, limit = 20) {
  const comm = await communityDetail(null, idOrSlug);
  const [eventRows] = await db.execute(
    `SELECT e.id, e.title, e.event_date, e.start_time, e.end_time, e.venue, e.poster_path, e.category,
            u.full_name AS organizer_name,
            CASE WHEN u.account_type IN ('college','club') AND u.verified = 1 THEN 1 ELSE 0 END AS is_official
     FROM events e
     LEFT JOIN users u ON u.id = e.organizer_id
     WHERE e.is_published = 1 AND e.status IN ('SCHEDULED','ONGOING')
       AND (e.department_id = (SELECT department_id FROM communities WHERE id = ?)
            OR e.club_id = (SELECT club_id FROM communities WHERE id = ?))
     ORDER BY e.event_date ASC, e.start_time ASC
     LIMIT ?`,
    [comm.id, comm.id, String(Math.min(50, Math.max(1, parseInt(limit, 10) || 20)))]
  );
  return eventRows.map((r) => ({ ...r, is_official: !!Number(r.is_official) }));
}

async function toggleMembership(user, communityId) {
  const cid = parseInt(communityId, 10);
  const [c] = await db.execute('SELECT id, name FROM communities WHERE id = ?', [cid]);
  if (!c.length) throw new ApiError(404, 'Community not found');
  const [ex] = await db.execute('SELECT id FROM community_members WHERE community_id = ? AND user_id = ?', [cid, user.id]);
  let joined;
  if (ex.length) {
    await db.execute('DELETE FROM community_members WHERE id = ?', [ex[0].id]);
    joined = false;
  } else {
    await db.execute('INSERT INTO community_members (community_id, user_id) VALUES (?, ?)', [cid, user.id]);
    joined = true;
  }
  const [cnt] = await db.execute('SELECT COUNT(*) AS n FROM community_members WHERE community_id = ?', [cid]);
  return { joined, member_count: Number(cnt[0].n) };
}

// ---------------------------------------------------------------------------
// Discover: everything the right rail needs in one round trip
// ---------------------------------------------------------------------------
async function discover(viewer) {
  const uid = viewer ? viewer.id : 0;

  const [trending] = await db.execute(
    `SELECT p.id, p.title, p.content, p.kind, p.created_at,
            (SELECT COUNT(*) FROM post_comments c WHERE c.post_id = p.id) AS comment_count,
            (SELECT COUNT(*) FROM reactions r WHERE r.target_type='POST' AND r.target_id = p.id AND r.value = 1) AS like_count,
            COALESCE(c2.name, 'Campus') AS community_name
       FROM posts p
       LEFT JOIN communities c2 ON c2.id = p.community_id
      WHERE p.is_anonymous = 0
      ORDER BY (SELECT COUNT(*) FROM post_comments c3 WHERE c3.post_id = p.id) DESC,
               (SELECT COUNT(*) FROM reactions r2 WHERE r2.target_type='POST' AND r2.target_id = p.id AND r2.value = 1) DESC,
               p.created_at DESC
      LIMIT 5`
  );

  const [events] = await db.execute(
    `SELECT e.id, e.title, e.event_date, e.start_time, e.venue, e.poster_path, e.category,
            CASE WHEN u.account_type IN ('college','club') AND u.verified = 1 THEN 1 ELSE 0 END AS is_official,
            (SELECT COUNT(*) FROM event_interests i WHERE i.event_id = e.id) AS interest_count
       FROM events e
       LEFT JOIN users u ON u.id = e.organizer_id
      WHERE e.is_published = 1 AND e.status IN ('SCHEDULED','ONGOING')
        AND e.event_date >= CURRENT_DATE
      ORDER BY e.event_date ASC, e.start_time ASC
      LIMIT 4`
  );

  const [communities] = await db.execute(
    `SELECT c.id, c.name, c.slug, c.cover_path,
            (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS member_count,
            (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id) AS post_count
       FROM communities c
      ORDER BY member_count DESC, post_count DESC
      LIMIT 5`
  );

  const [students] = await db.execute(
    `SELECT u.id, u.full_name, u.avatar_path, u.account_type, u.verified, u.bio,
            d.code AS dept_code, u.year,
            (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS follower_count
       FROM users u
       LEFT JOIN departments d ON d.id = u.department_id
      WHERE u.is_active = 1 AND u.id <> ?
        AND NOT EXISTS (SELECT 1 FROM follows f2 WHERE f2.follower_id = ? AND f2.followee_id = u.id)
        AND u.account_type IN ('student','college','club')
      ORDER BY (u.account_type IN ('college','club')) DESC, follower_count DESC, u.full_name ASC
      LIMIT 5`,
    [uid, uid]
  );

  const [polls] = await db.execute(
    `SELECT p.id, p.poll_question, p.title, p.created_at,
            (SELECT COUNT(*) FROM poll_options o WHERE o.post_id = p.id) AS option_count,
            (SELECT COUNT(*) FROM poll_votes v WHERE v.post_id = p.id) AS vote_count
       FROM posts p
      WHERE p.kind = 'POLL' AND p.created_at > NOW() - INTERVAL '7 days'
      ORDER BY p.created_at DESC LIMIT 3`
  );

  const [trends] = await db.execute(
    `SELECT c.slug, c.name, COUNT(p.id) AS post_count
       FROM communities c LEFT JOIN posts p ON p.community_id = c.id
      GROUP BY c.slug, c.name HAVING COUNT(p.id) > 0
      ORDER BY post_count DESC, c.name ASC LIMIT 6`
  );

  const [achv] = await db.execute(
    `SELECT id, title, competition_name, position, created_at FROM achievements
      WHERE verification_status = 'VERIFIED'
      ORDER BY created_at DESC NULLS LAST, id DESC LIMIT 3`
  ).catch(() => [[], null]);

  return {
    trending_discussions: trending,
    upcoming_events: events.map((e) => ({ ...e, is_official: !!Number(e.is_official) })),
    popular_communities: communities,
    suggested_people: students.map((s) => ({ ...s, verified: !!Number(s.verified) })),
    daily_poll: polls[0] || null,
    pools_polls: polls,
    trending_tags: trends,
    recent_achievements: achv || [],
  };
}

// ---------------------------------------------------------------------------
// Campus search: students, posts, communities, clubs, events
// ---------------------------------------------------------------------------
async function search(viewer, { q = '', type = '' } = {}) {
  const term = String(q || '').trim();
  if (term.length < 2) return { query: term, students: [], posts: [], communities: [], clubs: [], events: [] };
  const like = `%${term}%`;
  const want = (k) => !type || type === k;

  const out = { query: term, students: [], posts: [], communities: [], clubs: [], events: [] };

  if (want('students')) {
    const [studRows] = await db.execute(
      `SELECT u.id, u.full_name, u.avatar_path, u.account_type, u.verified, u.bio, u.year,
              d.code AS dept_code, u.student_id,
              (SELECT COUNT(*) FROM follows f WHERE f.followee_id = u.id) AS follower_count
         FROM users u LEFT JOIN departments d ON d.id = u.department_id
        WHERE u.is_active = 1 AND (u.full_name ILIKE ? OR u.student_id ILIKE ? OR u.email ILIKE ?)
        ORDER BY (u.account_type IN ('college','club')) DESC, follower_count DESC, u.full_name ASC
        LIMIT 8`,
      [like, like, like]
    );
    out.students = studRows.map((r) => ({ ...r, verified: !!Number(r.verified) }));
  }

  if (want('posts')) {
    const [postRows] = await db.execute(
      `SELECT p.id, p.kind, p.title, p.content, p.created_at,
              ${AUTHOR_SELECT}, ${COUNT_SELECT}
         FROM posts p
         LEFT JOIN users u ON u.id = p.author_id
         LEFT JOIN departments d ON d.id = u.department_id
        WHERE p.is_anonymous = 0 AND (p.content ILIKE ? OR p.title ILIKE ?)
        ORDER BY (SELECT COUNT(*) FROM reactions r WHERE r.target_type='POST' AND r.target_id = p.id AND r.value = 1) DESC,
                 p.created_at DESC
        LIMIT 8`,
      [like, like]
    );
    const rows2 = await filterShieldedPosts(postRows, viewer);
    await attachPolls(rows2, viewer);
    out.posts = rows2;
  }

  if (want('communities')) {
  const [commRows] = await db.execute(
    `SELECT c.id, c.name, c.slug, c.description,
            (SELECT COUNT(*) FROM community_members m WHERE m.community_id = c.id) AS member_count,
            (SELECT COUNT(*) FROM posts p WHERE p.community_id = c.id) AS post_count
       FROM communities c
      WHERE c.name ILIKE ? OR c.slug ILIKE ? OR c.description ILIKE ?
      ORDER BY member_count DESC LIMIT 6`,
    [like, like, like]
  );
  out.communities = commRows;
  }

  if (want('clubs')) {
    const [clubRows2] = await db.execute(
      `SELECT c.id, c.name, c.category, c.description, c.logo_path,
              (SELECT COUNT(*) FROM club_members m WHERE m.club_id = c.id AND m.is_active = 1) AS member_count
         FROM clubs c
        WHERE c.status = 'ACTIVE' AND (c.name ILIKE ? OR c.description ILIKE ?)
        ORDER BY member_count DESC LIMIT 6`,
      [like, like]).catch(() => [[]]);
    out.clubs = clubRows2;
  }

  if (want('events')) {
    const [eventSearchRows2] = await db.execute(
      `SELECT e.id, e.title, e.event_date, e.start_time, e.venue, e.poster_path, e.category,
              CASE WHEN u.account_type IN ('college','club') AND u.verified = 1 THEN 1 ELSE 0 END AS is_official
         FROM events e LEFT JOIN users u ON u.id = e.organizer_id
        WHERE e.is_published = 1 AND (e.title ILIKE ? OR e.description ILIKE ? OR e.venue ILIKE ?)
        ORDER BY e.event_date DESC LIMIT 6`,
      [like, like, like]
    );
    out.events = eventSearchRows2.map((r) => ({ ...r, is_official: !!Number(r.is_official) }));
  }

  return out;
}  module.exports = {
  feed, createPost, getPost, deletePost, updatePost,
  react, comment, listComments, updateComment, deleteComment, toggleSave, savedPosts, votePoll,
  toggleFollow, followersList, followingList, socialProfile, updateProfile, profileCompletion, profileCompletionScore,
  listCommunities, communityDetail, communityMembers, communityEvents,
  toggleMembership, toggleEventInterest,
  discover, search,
  SORTS, KINDS, PAGE_SIZE, isOfficialAccount,
  filterShieldedPosts, filterShieldedComments,
};
