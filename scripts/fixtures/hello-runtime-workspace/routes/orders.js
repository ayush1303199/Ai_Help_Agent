'use strict';

const { handleOrder, listOrder } = require("../controllers/orderController.js");
const route = { method: "POST", path: "/api/orders" };
const collectionRoute = { method: 'GET', path: route.path };

function registerRoutes(app) {
  if (!app || typeof app.register !== 'function') throw new TypeError('A route registry is required.');
  app.register(route.method, route.path, async (request) => handleOrder(request));
  app.register(collectionRoute.method, collectionRoute.path, async () => listOrder());
  return [route, collectionRoute];
}

module.exports = { registerRoutes, route, collectionRoute };
