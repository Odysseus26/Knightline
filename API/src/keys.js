'use strict';

const KEYS = {
  // live.js — live tier (rotating slots)
  liveCurrent: 'bus:live:current',
  liveOld: 'bus:live:old',
  liveRotationBucket: 'bus:live:rotation:lastBucket',
  liveMeta: 'bus:live:meta',
  liveLock: 'bus:live:lock',

  // live.js — legacy route tier
  routeCurrent: 'bus:routes:current',
  routePrefix: 'bus:routes:',
  routeMeta: 'bus:routes:meta',

  // routes.js — static tier (rotating pointer)
  staticCurrent: 'bus:static:current',
  staticOld: 'bus:static:old',
  staticRotationBucket: 'bus:static:rotation:lastBucket',
  staticPrefix: 'bus:static:',
  staticMeta: 'bus:static:meta',
  staticLock: 'bus:static:lock',

  // routes.js — derived reverse index
  indexPrefix: 'bus:index:',

  // places.js — buildings/places tier (single pointer, no old slot)
  placesCurrent: 'bus:places:current',
  placesPrefix: 'bus:places:',
  placesMeta: 'bus:places:meta',
  placesLock: 'bus:places:lock',
  placesRotationBucket: 'bus:places:rotation:lastBucket',
};

module.exports = KEYS;