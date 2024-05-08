/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Bind resources to your worker in `wrangler.toml`. After adding bindings, a type definition for the
 * `Env` object can be regenerated with `npm run cf-typegen`.
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */
import { Stripe } from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { StripeService } from './helpers';

const relevantEvents = new Set([
	'product.created',
	'product.updated',
	'product.deleted',
	'price.created',
	'price.updated',
	'price.deleted',
	'checkout.session.completed',
	'customer.subscription.created',
	'customer.subscription.updated',
	'customer.subscription.deleted',
]);

function createStripeClient(apiKey: string) {
	return new Stripe(apiKey, {
		appInfo: {
			// For sample support and debugging, not required for production:
			name: 'stripe-samples/stripe-node-cloudflare-worker-template',
			version: '0.0.1',
			url: 'https://github.com/stripe-samples',
		},
	});
}

function createSupabaseClient(apiUrl: string, apiKey: string) {
	return createClient(apiUrl, apiKey);
}

export default {
	async fetch(request: any, env: any, context: any) {
		if (request.method === 'POST') {
			const payload = await request.text();
			const signature = request.headers.get('stripe-signature');
			const stripe = createStripeClient(env?.STRIPE_API_KEY);
			const supabase = createSupabaseClient(env?.SUPABASE_URL, env?.SUPABASE_API_KEY);
			const webhookSecret = (env?.STRIPE_WEBHOOK_SECRET as string) || '';
			let event: Stripe.Event;

			// create a stripe service
			const stripeService = new StripeService(stripe, supabase);

			try {
				if (!signature || !webhookSecret || !payload) {
					return new Response('Webhook secret not found.', { status: 400 });
				}

				event = await stripe.webhooks.constructEventAsync(
					payload,
					signature,
					webhookSecret,
					undefined,
					Stripe.createSubtleCryptoProvider()
				);
				console.log(`🔔  Webhook received: ${event.type}`);
			} catch (error: any) {
				console.log(`❌ Error message: ${error.message}`);
				return new Response(`Webhook Error: ${error.message}`, { status: 400 });
			}

			if (relevantEvents.has(event.type)) {
				try {
				  switch (event.type) {
					case "product.created":
					case "product.updated":
					  await stripeService.upsertProductRecord(event.data.object as Stripe.Product)
					  break
					case "price.created":
					case "price.updated":
					  await stripeService.upsertPriceRecord(event.data.object as Stripe.Price)
					  break
					case "price.deleted":
					  await stripeService.deletePriceRecord(event.data.object as Stripe.Price)
					  break
					case "product.deleted":
					  await stripeService.deleteProductRecord(event.data.object as Stripe.Product)
					  break
					case "customer.subscription.created":
					case "customer.subscription.deleted":
					case "customer.subscription.updated":
					  const updated_subscription = event.data.object as Stripe.Subscription
					  await stripeService.manageSubscriptionStatusChange(
						updated_subscription.id,
						updated_subscription.customer as string,
					  )
					  break
					case "checkout.session.completed":
					  const checkoutSession = event.data.object as Stripe.Checkout.Session
					  if (checkoutSession.mode === "subscription") {
						const subscriptionId = checkoutSession.subscription
						await stripeService.manageSubscriptionStatusChange(
						  subscriptionId as string,
						  checkoutSession.customer as string,
						  true,
						)
					  }
					  break
					default:
					  console.log(`Unhandled relevant event: ${event.type}`)
					  throw new Response("Unhandled relevant event!", { status: 400 })
				  }
				} catch (error: any) {
				  console.log(error)
				  return new Response(`Webhook Error: ${error.message}`, { status: 400 })
				}
			  } else {
				console.log(`Unsupported event type: ${event.type}`)
				return new Response(`Unsupported event type: ${event.type}`, {
				  status: 400,
				})
			  }
			  return new Response(JSON.stringify({ received: true }))
		}
		return new Response('Hello World!');
	},
};
