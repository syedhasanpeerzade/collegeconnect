'use strict';
const social = require('../services/socialService');
const { asyncHandler } = require('../utils/helpers');

const ok = (res, data, message, status = 200) => res.status(status).json({ success: true, message: message || 'OK', data });

async function feed(req, res) {
  const data = await social.feed(req.user, {
    tab: req.query.tab, kind: req.query.kind,
    communityId: req.query.community_id, authorId: req.query.author_id, page: req.query.page,
    sort: req.query.sort,
  });
  ok(res, data);
}

async function getPost(req, res) { ok(res, await social.getPost(req.user, req.params.id)); }
async function listComments(req, res) { ok(res, await social.listComments(req.user, req.params.id)); }

async function createPost(req, res) {
  const payload = req.body || {};
  const files = req.files || {};
  if (payload.poll_options && typeof payload.poll_options === 'string') {
    try { payload.poll_options = JSON.parse(payload.poll_options); } catch (_e) {
      payload.poll_options = String(payload.poll_options).split('|').map((s) => s.trim()).filter(Boolean);
    }
  }
  const r = await social.createPost(req.user, payload, files);
  const post = await social.getPost(req.user, r.id);
  ok(res, post, 'Posted', 201);
}

async function deletePost(req, res) { await social.deletePost(req.user, req.params.id); ok(res, null, 'Post deleted'); }

async function updatePost(req, res) {
  await social.updatePost(req.user, req.params.id, req.body || {});
  ok(res, await social.getPost(req.user, req.params.id), 'Post updated');
}

async function react(req, res) {
  const r = await social.react(req.user, req.body.target_type, req.body.target_id, req.body.value);
  ok(res, r, r.reacted ? 'Reaction saved' : 'Reaction removed');
}

async function updateComment(req, res) {
  const r = await social.updateComment(req.user, req.params.commentId, req.body || {});
  ok(res, r, 'Comment updated');
}

async function deleteComment(req, res) {
  await social.deleteComment(req.user, req.params.commentId);
  ok(res, null, 'Comment deleted');
}

async function comment(req, res) {
  const r = await social.comment(req.user, req.params.id, req.body || {});
  const comments = await social.listComments(req.user, req.params.id);
  ok(res, { new_comment_id: r.id, comments }, 'Comment added', 201);
}

async function toggleSave(req, res) {
  const r = await social.toggleSave(req.user, req.params.id);
  ok(res, r, r.saved ? 'Saved' : 'Removed from saved');
}

async function toggleFollow(req, res) {
  const r = await social.toggleFollow(req.user, req.params.id);
  ok(res, r, r.following ? 'Following' : 'Unfollowed');
}

async function socialProfile(req, res) { ok(res, await social.socialProfile(req.user, req.params.id)); }

async function followers(req, res) {
  ok(res, await social.followersList(req.user, req.params.id, req.query.limit));
}

async function following(req, res) {
  ok(res, await social.followingList(req.user, req.params.id, req.query.limit));
}

async function updateProfile(req, res) {
  await social.updateProfile(req.user, req.body || {}, req.files || {});
  ok(res, await social.socialProfile(req.user, req.user.id), 'Profile updated');
}

async function deletePhoto(req, res) {
  await social.deletePhoto(req.user, { kind: req.params.kind });
  ok(res, await social.socialProfile(req.user, req.user.id), 'Photo removed');
}

async function listCommunities(req, res) { ok(res, await social.listCommunities(req.user)); }
async function communityDetail(req, res) { ok(res, await social.communityDetail(req.user, req.params.id)); }
async function communityMembers(req, res) {
  ok(res, await social.communityMembers(req.params.id, req.query.limit));
}

async function communityEvents(req, res) {
  ok(res, await social.communityEvents(req.params.id, req.query.limit));
}

async function toggleMembership(req, res) {
  const r = await social.toggleMembership(req.user, req.params.id);
  ok(res, r, r.joined ? 'Joined community' : 'Left community');
}

async function toggleEventInterest(req, res) {
  const r = await social.toggleEventInterest(req.user, req.params.id);
  ok(res, r, r.interested ? 'Marked as interested' : 'No longer interested');
}

async function savedPosts(req, res) { ok(res, await social.savedPosts(req.user)); }

async function discover(req, res) { ok(res, await social.discover(req.user)); }

async function profileCompletion(req, res) {
  const viewer = req.user;
  const uid = parseInt(req.params.id, 10) || (viewer ? viewer.id : 0);
  const data = await social.profileCompletion(viewer, uid);
  ok(res, data);
}

async function search(req, res) {
  ok(res, await social.search(req.user, { q: req.query.q, type: req.query.type }));
}

async function votePoll(req, res) {
  const post = await social.votePoll(req.user, req.params.id, (req.body || {}).option_id);
  ok(res, post, 'Vote recorded');
}

// Every handler is wrapped so a rejected promise becomes a 500 JSON response
// instead of an unhandled rejection that takes the whole server down.
module.exports = {
  feed: asyncHandler(feed),
  getPost: asyncHandler(getPost),
  listComments: asyncHandler(listComments),
  createPost: asyncHandler(createPost),
  deletePost: asyncHandler(deletePost),
  updatePost: asyncHandler(updatePost),
  react: asyncHandler(react),
  comment: asyncHandler(comment),
  updateComment: asyncHandler(updateComment),
  deleteComment: asyncHandler(deleteComment),
  toggleSave: asyncHandler(toggleSave),
  toggleFollow: asyncHandler(toggleFollow),
  socialProfile: asyncHandler(socialProfile),
  followers: asyncHandler(followers),
  following: asyncHandler(following),
  updateProfile: asyncHandler(updateProfile),
  deletePhoto: asyncHandler(deletePhoto),
  listCommunities: asyncHandler(listCommunities),
  communityDetail: asyncHandler(communityDetail),
  communityMembers: asyncHandler(communityMembers),
  communityEvents: asyncHandler(communityEvents),
  toggleMembership: asyncHandler(toggleMembership),
  toggleEventInterest: asyncHandler(toggleEventInterest),
  savedPosts: asyncHandler(savedPosts),
  votePoll: asyncHandler(votePoll),
  discover: asyncHandler(discover),
  search: asyncHandler(search),
  profileCompletion: asyncHandler(profileCompletion),
};
