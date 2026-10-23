'use strict';
const fs = require('fs');
const src = fs.readFileSync('./client/js/social.js', 'utf8');
if (!src.includes('card(p, user, index = 0)')) throw new Error('missing card()');
if (!src.includes('cardRaw(p, user, index = 0)')) throw new Error('missing cardRaw()');
if (src.includes('DOM only')) throw new Error('stale comment present');
console.log('social.js signature OK');
