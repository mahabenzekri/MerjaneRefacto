import {
	describe, it, expect, beforeEach,
	afterEach,
} from 'vitest';
import {mockDeep, type DeepMockProxy} from 'vitest-mock-extended';
import {type INotificationService} from '../notifications.port.js';
import {createDatabaseMock, cleanUp} from '../../utils/test-utils/database-tools.ts.js';
import {ProductService} from './product.service.js';
import {products, type Product} from '@/db/schema.js';
import {type Database} from '@/db/type.js';

describe('ProductService Tests', () => {
	let notificationServiceMock: DeepMockProxy<INotificationService>;
	let productService: ProductService;
	let databaseMock: Database;
	let databaseName: string;
	let closeDatabase: () => void;

	beforeEach(async () => {
		({databaseMock, databaseName, close: closeDatabase} = await createDatabaseMock());
		notificationServiceMock = mockDeep<INotificationService>();
		productService = new ProductService({
			notificationService: notificationServiceMock,
			db: databaseMock,
		});
	});

	afterEach(async () => {
		closeDatabase();
		await cleanUp(databaseName);
	});

	// ─── NORMAL PRODUCT TESTS ────────────────────────────────────────────

	describe('NORMAL products', () => {
		it('should decrement stock when product is available', async () => {
			const product = await insertProduct({
				leadTime: 15, available: 10, type: 'NORMAL', name: 'USB Cable',
			});

			await productService.processProduct(product);

			const result = await findProduct(product.id);
			expect(result!.available).toBe(9);
			expect(notificationServiceMock.sendDelayNotification).not.toHaveBeenCalled();
		});

		it('should notify delay when out of stock with positive lead time', async () => {
			const product = await insertProduct({
				leadTime: 15, available: 0, type: 'NORMAL', name: 'USB Dongle',
			});

			await productService.processProduct(product);

			const result = await findProduct(product.id);
			expect(result!.available).toBe(0);
			expect(notificationServiceMock.sendDelayNotification).toHaveBeenCalledWith(15, 'USB Dongle');
		});

		it('should do nothing when out of stock with zero lead time', async () => {
			const product = await insertProduct({
				leadTime: 0, available: 0, type: 'NORMAL', name: 'Discontinued Item',
			});

			await productService.processProduct(product);

			const result = await findProduct(product.id);
			expect(result!.available).toBe(0);
			expect(notificationServiceMock.sendDelayNotification).not.toHaveBeenCalled();
		});
	});

	// ─── SEASONAL PRODUCT TESTS ──────────────────────────────────────────

	describe('SEASONAL products', () => {
		const DAY_MS = 24 * 60 * 60 * 1000;

		it('should decrement stock when in season and available', async () => {
			const product = await insertProduct({
				leadTime: 15,
				available: 30,
				type: 'SEASONAL',
				name: 'Watermelon',
				seasonStartDate: new Date(Date.now() - (10 * DAY_MS)),
				seasonEndDate: new Date(Date.now() + (60 * DAY_MS)),
			});

			await productService.processProduct(product);

			const result = await findProduct(product.id);
			expect(result!.available).toBe(29);
			expect(notificationServiceMock.sendOutOfStockNotification).not.toHaveBeenCalled();
			expect(notificationServiceMock.sendDelayNotification).not.toHaveBeenCalled();
		});

		it('should notify out of stock when before season starts', async () => {
			const product = await insertProduct({
				leadTime: 15,
				available: 30,
				type: 'SEASONAL',
				name: 'Grapes',
				seasonStartDate: new Date(Date.now() + (180 * DAY_MS)),
				seasonEndDate: new Date(Date.now() + (240 * DAY_MS)),
			});

			await productService.processProduct(product);

			expect(notificationServiceMock.sendOutOfStockNotification).toHaveBeenCalledWith('Grapes');
		});

		it('should notify out of stock when restock would exceed season end', async () => {
			const product = await insertProduct({
				leadTime: 90,
				available: 0,
				type: 'SEASONAL',
				name: 'Pumpkin',
				seasonStartDate: new Date(Date.now() - (10 * DAY_MS)),
				seasonEndDate: new Date(Date.now() + (30 * DAY_MS)),
			});

			await productService.processProduct(product);

			const result = await findProduct(product.id);
			expect(result!.available).toBe(0);
			expect(notificationServiceMock.sendOutOfStockNotification).toHaveBeenCalledWith('Pumpkin');
		});

		it('should notify delay when in season, out of stock, and restock within season', async () => {
			const product = await insertProduct({
				leadTime: 5,
				available: 0,
				type: 'SEASONAL',
				name: 'Strawberry',
				seasonStartDate: new Date(Date.now() - (10 * DAY_MS)),
				seasonEndDate: new Date(Date.now() + (60 * DAY_MS)),
			});

			await productService.processProduct(product);

			expect(notificationServiceMock.sendDelayNotification).toHaveBeenCalledWith(5, 'Strawberry');
			expect(notificationServiceMock.sendOutOfStockNotification).not.toHaveBeenCalled();
		});
	});

	// ─── EXPIRABLE PRODUCT TESTS ─────────────────────────────────────────

	describe('EXPIRABLE products', () => {
		const DAY_MS = 24 * 60 * 60 * 1000;

		it('should decrement stock when available and not expired', async () => {
			const product = await insertProduct({
				leadTime: 15,
				available: 30,
				type: 'EXPIRABLE',
				name: 'Butter',
				expiryDate: new Date(Date.now() + (26 * DAY_MS)),
			});

			await productService.processProduct(product);

			const result = await findProduct(product.id);
			expect(result!.available).toBe(29);
			expect(notificationServiceMock.sendExpirationNotification).not.toHaveBeenCalled();
		});

		it('should send expiration notification when product has expired', async () => {
			const expiryDate = new Date(Date.now() - (2 * DAY_MS));
			const product = await insertProduct({
				leadTime: 90,
				available: 6,
				type: 'EXPIRABLE',
				name: 'Milk',
				expiryDate,
			});

			await productService.processProduct(product);

			const result = await findProduct(product.id);
			expect(result!.available).toBe(0);
			expect(notificationServiceMock.sendExpirationNotification).toHaveBeenCalledWith('Milk', expiryDate);
		});

		it('should send expiration notification when out of stock even if not expired', async () => {
			const expiryDate = new Date(Date.now() + (10 * DAY_MS));
			const product = await insertProduct({
				leadTime: 15,
				available: 0,
				type: 'EXPIRABLE',
				name: 'Yogurt',
				expiryDate,
			});

			await productService.processProduct(product);

			const result = await findProduct(product.id);
			expect(result!.available).toBe(0);
			expect(notificationServiceMock.sendExpirationNotification).toHaveBeenCalledWith('Yogurt', expiryDate);
		});
	});

	// ─── HELPERS ─────────────────────────────────────────────────────────

	async function insertProduct(data: Omit<Product, 'id'> & {id?: number}): Promise<Product> {
		const [inserted] = await databaseMock.insert(products).values(data).returning();
		return inserted!;
	}

	async function findProduct(id: number): Promise<Product | undefined> {
		return databaseMock.query.products.findFirst({
			where: (p, {eq}) => eq(p.id, id),
		});
	}
});
