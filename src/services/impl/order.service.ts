import {type Cradle} from '@fastify/awilix';
import {eq} from 'drizzle-orm';
import {type ProductService} from './product.service.js';
import {orders} from '@/db/schema.js';
import {type Database} from '@/db/type.js';

export class OrderService {
	private readonly db: Database;
	private readonly productService: ProductService;

	public constructor({db, productService}: Pick<Cradle, 'db' | 'productService'>) {
		this.db = db;
		this.productService = productService;
	}

	public async processOrder(orderId: number): Promise<{orderId: number}> {
		const order = await this.db.query.orders.findFirst({
			where: eq(orders.id, orderId),
			with: {
				products: {
					columns: {},
					with: {
						product: true,
					},
				},
			},
		});

		if (!order) {
			throw new Error(`Order with id ${orderId} not found`);
		}

		const {products: productList} = order;

		if (productList) {
			for (const {product} of productList) {
				await this.productService.processProduct(product); // eslint-disable-line no-await-in-loop
			}
		}

		return {orderId: order.id};
	}
}
