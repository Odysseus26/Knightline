const fs = require('fs');
const path = require('path');

const REGION_ID = 'CA558DDC-D7F2-4B48-9CAC-DEEA1134F820';
const LX_ROUTE_ID = 'DFE55715-C70E-4130-BBAE-DFBE92FA3493';

function buildTripShotUrl(sharedRouteId, date = new Date()) {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  return `https://rutgers.tripshot.com/g/tms/Public.html#RoutePlace:%7B%22regionId%22:%22${REGION_ID}%22,%20%22date%22:%7B%22year%22:${year},%20%22month%22:${month},%20%22day%22:${day}%7D,%20%22sharedRouteId%22:%22${sharedRouteId}%22,%20%22noNav%22:false%7D`;
}

// Keeps the original behavior: no args = LX Route for today
function getRutgersTripShotUrl(date = new Date()) {
  return buildTripShotUrl(LX_ROUTE_ID, date);
}

// Returns an object: { "A Route": "https://...", "B Route": "https://...", ... }
function getAllRutgersTripShotUrls(
  date = new Date(),
  linksFile = path.join(__dirname, 'links.txt')
) {
  const text = fs.readFileSync(linksFile, 'utf8');
  const routes = {};

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Matches: Route Name: https://...
    const lineMatch = trimmed.match(/^(.+?):\s*(https?:\/\/\S+)\s*$/);
    if (!lineMatch) continue;

    const name = lineMatch[1].trim();
    const originalUrl = lineMatch[2].trim();

    // Pull out sharedRouteId from the existing URL
    const idMatch = originalUrl.match(/sharedRouteId%22:%22([^%]+)%22/);
    if (!idMatch) continue;

    routes[name] = buildTripShotUrl(idMatch[1], date);
  }

  return routes;
}

// Optional: returns an array instead: [{ name, url }, ...]
function getAllRutgersTripShotUrlList(
  date = new Date(),
  linksFile = path.join(__dirname, 'links.txt')
) {
  return Object.entries(getAllRutgersTripShotUrls(date, linksFile)).map(
    ([name, url]) => ({ name, url })
  );
}

module.exports = {
  getRutgersTripShotUrl,
  getAllRutgersTripShotUrls,
  getAllRutgersTripShotUrlList,
  buildTripShotUrl
};