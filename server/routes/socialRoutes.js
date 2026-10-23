'use strict';
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/socialController');
const verify = require('../controllers/verificationController');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { uploads, uploadErrorHandler } = require('../middleware/upload');

// Public feed (optional auth personalizes it)
router.get('/feed', optionalAuth, ctrl.feed);
router.get('/posts/:id', optionalAuth, ctrl.getPost);
router.get('/posts/:id/comments', optionalAuth, ctrl.listComments);
router.get('/communities', optionalAuth, ctrl.listCommunities);
router.get('/communities/:id', optionalAuth, ctrl.communityDetail);
router.get('/communities/:id/members', optionalAuth, ctrl.communityMembers);
router.get('/communities/:id/events', optionalAuth, ctrl.communityEvents);
router.get('/users/:id/social', optionalAuth, ctrl.socialProfile);
router.get('/users/:id/followers', optionalAuth, ctrl.followers);
router.get('/users/:id/following', optionalAuth, ctrl.following);
router.get('/saved', authenticate, ctrl.savedPosts);
router.get('/discover', optionalAuth, ctrl.discover);
router.get('/search', optionalAuth, ctrl.search);
router.get('/official-accounts', optionalAuth, verify.officially);
router.get('/verification-requests/mine', authenticate, verify.mine);
router.post('/verification-requests', authenticate, verify.request);

// Authenticated social actions
router.post('/posts', authenticate, uploads.postMedia, uploadErrorHandler, ctrl.createPost);
router.put('/posts/:id', authenticate, ctrl.updatePost); // edit own post (author / staff)
router.delete('/posts/:id', authenticate, ctrl.deletePost);
router.put('/posts/:id/comments/:commentId', authenticate, ctrl.updateComment);
router.delete('/posts/:id/comments/:commentId', authenticate, ctrl.deleteComment);
router.put('/reactions', authenticate, ctrl.react);
router.post('/posts/:id/comments', authenticate, ctrl.comment);
router.put('/posts/:id/save', authenticate, ctrl.toggleSave);
router.put('/posts/:id/poll', authenticate, ctrl.votePoll);
router.put('/users/:id/follow', authenticate, ctrl.toggleFollow);
router.put('/users/:id/social', authenticate, uploads.profileImages, uploadErrorHandler, ctrl.updateProfile);
router.put('/users/:id/photos', authenticate, ctrl.updateProfile);
router.delete('/users/:id/photos/:kind', authenticate, ctrl.deletePhoto);
router.get('/users/:id/completion', authenticate, ctrl.profileCompletion);
router.put('/communities/:id/join', authenticate, ctrl.toggleMembership);
router.put('/events/:id/interested', authenticate, ctrl.toggleEventInterest);

module.exports = router;
