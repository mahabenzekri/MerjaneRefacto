import {type Cradle} from '@fastify/awilix';
import {eq} from 'drizzle-orm';
import {type INotificationService} from '../notifications.port.js';
import {products, type Product} from '@/db/schema.js';
import {type Database} from '@/db/type.js';

const MILLISECONDS_PER_DAY = 1000 * 60 * 60 * 24;

export class ProductService {
	private readonly notificationService: INotificationService;
	private readonly db: Database;

	public constructor({notificationService, db}: Pick<Cradle, 'notificationService' | 'db'>) {
		this.notificationService = notificationService;
		this.db = db;
	}

	public async processProduct(product: Product): Promise<void> {
		switch (product.type) {
			case 'NORMAL': {
				await this.processNormalProduct(product);
				break;
			}

			case 'SEASONAL': {
				await this.processSeasonalProduct(product);
				break;
			}

			case 'EXPIRABLE': {
				await this.processExpirableProduct(product);
				break;
			}

			default: {
				break;
			}
		}
	}

	private async processNormalProduct(product: Product): Promise<void> {
		if (product.available > 0) {
			await this.decrementStock(product);
		} else if (product.leadTime > 0) {
			await this.notifyDelay(product);
		}
	}

	private async processSeasonalProduct(product: Product): Promise<void> {
		const now = new Date();

		if (this.isInSeason(product, now) && product.available > 0) {
			await this.decrementStock(product);
			return;
		}

		if (this.isBeforeSeason(product, now)) {
			this.notificationService.sendOutOfStockNotification(product.name);
			await this.updateProduct(product);
			return;
		}

		if (this.isRestockBeyondSeason(product, now)) {
			this.notificationService.sendOutOfStockNotification(product.name);
			product.available = 0;
			await this.updateProduct(product);
			return;
		}

		await this.notifyDelay(product);
	}

	private async processExpirableProduct(product: Product): Promise<void> {
		const now = new Date();

		if (product.available > 0 && product.expiryDate! > now) {
			await this.decrementStock(product);
		} else {
			this.notificationService.sendExpirationNotification(product.name, product.expiryDate!);
			product.available = 0;
			await this.updateProduct(product);
		}
	}

	private isInSeason(product: Product, now: Date): boolean {
		return now > product.seasonStartDate! && now < product.seasonEndDate!;
	}

	private isBeforeSeason(product: Product, now: Date): boolean {
		return product.seasonStartDate! > now;
	}

	private isRestockBeyondSeason(product: Product, now: Date): boolean {
		const restockDate = new Date(now.getTime() + (product.leadTime * MILLISECONDS_PER_DAY));
		return restockDate > product.seasonEndDate!;
	}

	private async decrementStock(product: Product): Promise<void> {
		product.available -= 1;
		await this.updateProduct(product);
	}

	private async notifyDelay(product: Product): Promise<void> {
		await this.updateProduct(product);
		this.notificationService.sendDelayNotification(product.leadTime, product.name);
	}

	private async updateProduct(product: Product): Promise<void> {
		await this.db.update(products).set(product).where(eq(products.id, product.id));
	}
}
