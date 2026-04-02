import {
	describe, it, expect, beforeEach,
	afterEach,
} from 'vitest';
import {type FastifyInstance} from 'fastify';
import supertest from 'supertest';
import {eq} from 'drizzle-orm';
import {type DeepMockProxy, mockDeep} from 'vitest-mock-extended';
import {asValue} from 'awilix';
import {type INotificationService} from '@/services/notifications.port.js';
import {
	type ProductInsert,
	products,
	orders,
	ordersToProducts,
} from '@/db/schema.js';
import {type Database} from '@/db/type.js';
import {buildFastify} from '@/fastify.js';

describe('MyController Integration Tests', () => {
	let fastify: FastifyInstance;
	let database: Database;
	let notificationServiceMock: DeepMockProxy<INotificationService>;

	beforeEach(async () => {
		notificationServiceMock = mockDeep<INotificationService>();

		fastify = await buildFastify();
		fastify.diContainer.register({
			notificationService: asValue(notificationServiceMock as INotificationService),
		});
		await fastify.ready();
		database = fastify.database;
	});
	afterEach(async () => {
		await fastify.close();
	});

	it('should return 200 and process an order with mixed product types', async () => {
		const client = supertest(fastify.server);
		const allProducts = createProducts();
		const orderId = createOrderWithProducts(allProducts);

		await client.post(`/orders/${orderId}/processOrder`).expect(200).expect('Content-Type', /application\/json/);

		const resultOrder = await database.query.orders.findFirst({where: eq(orders.id, orderId)});
		expect(resultOrder!.id).toBe(orderId);
	});

	// ─── NORMAL PRODUCT TESTS ────────────────────────────────────────────

	describe('NORMAL products', () => {
		it('should decrement available stock for a normal product in stock', async () => {
			const client = supertest(fastify.server);
			const orderId = createOrderWithProducts([
				{
					leadTime: 15, available: 30, type: 'NORMAL', name: 'USB Cable',
				},
			]);

			await client.post(`/orders/${orderId}/processOrder`).expect(200);

			const result = await database.query.products.findFirst({where: eq(products.name, 'USB Cable')});
			expect(result!.available).toBe(29);
			expect(notificationServiceMock.sendDelayNotification).not.toHaveBeenCalled();
		});

		it('should notify delay for a normal product out of stock with positive lead time', async () => {
			const client = supertest(fastify.server);
			const orderId = createOrderWithProducts([
				{
					leadTime: 10, available: 0, type: 'NORMAL', name: 'USB Dongle',
				},
			]);

			await client.post(`/orders/${orderId}/processOrder`).expect(200);

			const result = await database.query.products.findFirst({where: eq(products.name, 'USB Dongle')});
			expect(result!.available).toBe(0);
			expect(notificationServiceMock.sendDelayNotification).toHaveBeenCalledWith(10, 'USB Dongle');
		});

		it('should do nothing for a normal product out of stock with zero lead time', async () => {
			const client = supertest(fastify.server);
			const orderId = createOrderWithProducts([
				{
					leadTime: 0, available: 0, type: 'NORMAL', name: 'Discontinued Item',
				},
			]);

			await client.post(`/orders/${orderId}/processOrder`).expect(200);

			const result = await database.query.products.findFirst({where: eq(products.name, 'Discontinued Item')});
			expect(result!.available).toBe(0);
			expect(notificationServiceMock.sendDelayNotification).not.toHaveBeenCalled();
		});
	});

	// ─── SEASONAL PRODUCT TESTS ──────────────────────────────────────────

	describe('SEASONAL products', () => {
		const DAY_MS = 24 * 60 * 60 * 1000;

		it('should decrement stock for a seasonal product in season and available', async () => {
			const client = supertest(fastify.server);
			const orderId = createOrderWithProducts([
				{
					leadTime: 15,
					available: 30,
					type: 'SEASONAL',
					name: 'Watermelon',
					seasonStartDate: new Date(Date.now() - (2 * DAY_MS)),
					seasonEndDate: new Date(Date.now() + (58 * DAY_MS)),
				},
			]);

			await client.post(`/orders/${orderId}/processOrder`).expect(200);

			const result = await database.query.products.findFirst({where: eq(products.name, 'Watermelon')});
			expect(result!.available).toBe(29);
			expect(notificationServiceMock.sendOutOfStockNotification).not.toHaveBeenCalled();
		});

		it('should notify out of stock for a seasonal product before season', async () => {
			const client = supertest(fastify.server);
			const orderId = createOrderWithProducts([
				{
					leadTime: 15,
					available: 30,
					type: 'SEASONAL',
					name: 'Grapes',
					seasonStartDate: new Date(Date.now() + (180 * DAY_MS)),
					seasonEndDate: new Date(Date.now() + (240 * DAY_MS)),
				},
			]);

			await client.post(`/orders/${orderId}/processOrder`).expect(200);

			expect(notificationServiceMock.sendOutOfStockNotification).toHaveBeenCalledWith('Grapes');
		});

		it('should notify out of stock when restock exceeds season end', async () => {
			const client = supertest(fastify.server);
			const orderId = createOrderWithProducts([
				{
					leadTime: 90,
					available: 0,
					type: 'SEASONAL',
					name: 'Pumpkin',
					seasonStartDate: new Date(Date.now() - (10 * DAY_MS)),
					seasonEndDate: new Date(Date.now() + (30 * DAY_MS)),
				},
			]);

			await client.post(`/orders/${orderId}/processOrder`).expect(200);

			const result = await database.query.products.findFirst({where: eq(products.name, 'Pumpkin')});
			expect(result!.available).toBe(0);
			expect(notificationServiceMock.sendOutOfStockNotification).toHaveBeenCalledWith('Pumpkin');
		});

		it('should notify delay for a seasonal product in season and out of stock with restock within season', async () => {
			const client = supertest(fastify.server);
			const orderId = createOrderWithProducts([
				{
					leadTime: 5,
					available: 0,
					type: 'SEASONAL',
					name: 'Strawberry',
					seasonStartDate: new Date(Date.now() - (10 * DAY_MS)),
					seasonEndDate: new Date(Date.now() + (60 * DAY_MS)),
				},
			]);

			await client.post(`/orders/${orderId}/processOrder`).expect(200);

			expect(notificationServiceMock.sendDelayNotification).toHaveBeenCalledWith(5, 'Strawberry');
			expect(notificationServiceMock.sendOutOfStockNotification).not.toHaveBeenCalled();
		});
	});

	// ─── EXPIRABLE PRODUCT TESTS ─────────────────────────────────────────

	describe('EXPIRABLE products', () => {
		const DAY_MS = 24 * 60 * 60 * 1000;

		it('should decrement stock for an expirable product available and not expired', async () => {
			const client = supertest(fastify.server);
			const orderId = createOrderWithProducts([
				{
					leadTime: 15,
					available: 30,
					type: 'EXPIRABLE',
					name: 'Butter',
					expiryDate: new Date(Date.now() + (26 * DAY_MS)),
				},
			]);

			await client.post(`/orders/${orderId}/processOrder`).expect(200);

			const result = await database.query.products.findFirst({where: eq(products.name, 'Butter')});
			expect(result!.available).toBe(29);
			expect(notificationServiceMock.sendExpirationNotification).not.toHaveBeenCalled();
		});

		it('should send expiration notification and set available to 0 when product is expired', async () => {
			const client = supertest(fastify.server);
			const expiryDate = new Date(Date.now() - (2 * DAY_MS));
			const orderId = createOrderWithProducts([
				{
					leadTime: 90,
					available: 6,
					type: 'EXPIRABLE',
					name: 'Milk',
					expiryDate,
				},
			]);

			await client.post(`/orders/${orderId}/processOrder`).expect(200);

			const result = await database.query.products.findFirst({where: eq(products.name, 'Milk')});
			expect(result!.available).toBe(0);
			expect(notificationServiceMock.sendExpirationNotification).toHaveBeenCalledWith('Milk', expiryDate);
		});

		it('should send expiration notification when out of stock even if not expired', async () => {
			const client = supertest(fastify.server);
			const expiryDate = new Date(Date.now() + (10 * DAY_MS));
			const orderId = createOrderWithProducts([
				{
					leadTime: 15,
					available: 0,
					type: 'EXPIRABLE',
					name: 'Yogurt',
					expiryDate,
				},
			]);

			await client.post(`/orders/${orderId}/processOrder`).expect(200);

			const result = await database.query.products.findFirst({where: eq(products.name, 'Yogurt')});
			expect(result!.available).toBe(0);
			expect(notificationServiceMock.sendExpirationNotification).toHaveBeenCalledWith('Yogurt', expiryDate);
		});
	});

	// ─── HELPERS ─────────────────────────────────────────────────────────

	function createOrderWithProducts(productList: ProductInsert[]): number {
		return database.transaction(tx => {
			const insertedProducts = tx.insert(products).values(productList).returning({productId: products.id}).all();
			const order = tx.insert(orders).values([{}]).returning({orderId: orders.id}).get();
			tx.insert(ordersToProducts).values(insertedProducts.map(p => ({orderId: order!.orderId, productId: p.productId}))).run();
			return order!.orderId;
		});
	}

	function createProducts(): ProductInsert[] {
		const DAY_MS = 24 * 60 * 60 * 1000;
		return [
			{
				leadTime: 15, available: 30, type: 'NORMAL', name: 'USB Cable',
			},
			{
				leadTime: 10, available: 0, type: 'NORMAL', name: 'USB Dongle',
			},
			{
				leadTime: 15, available: 30, type: 'EXPIRABLE', name: 'Butter', expiryDate: new Date(Date.now() + (26 * DAY_MS)),
			},
			{
				leadTime: 90, available: 6, type: 'EXPIRABLE', name: 'Milk', expiryDate: new Date(Date.now() - (2 * DAY_MS)),
			},
			{
				leadTime: 15, available: 30, type: 'SEASONAL', name: 'Watermelon', seasonStartDate: new Date(Date.now() - (2 * DAY_MS)), seasonEndDate: new Date(Date.now() + (58 * DAY_MS)),
			},
			{
				leadTime: 15, available: 30, type: 'SEASONAL', name: 'Grapes', seasonStartDate: new Date(Date.now() + (180 * DAY_MS)), seasonEndDate: new Date(Date.now() + (240 * DAY_MS)),
			},
		];
	}
});
