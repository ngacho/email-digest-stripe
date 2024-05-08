import Stripe from 'stripe';
import { SupabaseClient } from '@supabase/supabase-js';

export class StripeService {
  private stripe: Stripe;
  private supabaseAdmin: SupabaseClient;

  constructor(stripe: Stripe, supabaseAdmin : SupabaseClient<any, "public", any>) {
    this.stripe = stripe;
    this.supabaseAdmin = supabaseAdmin;
  }

  public async findSubscription(
    subscriptionId: string,
    retryCount = 0,
    maxRetries = 3
  ): Promise<Stripe.Subscription | undefined> {
    let subscription: Stripe.Subscription | undefined;
    try {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      subscription = await this.stripe.subscriptions.retrieve(subscriptionId);
    } catch (error: any) {
      switch (error.type) {
        case 'StripeCardError':
          console.log(`A payment error occurred: ${error.message}`);
          break;
        case 'StripeInvalidRequestError':
          console.log('An invalid request occurred.');
          if (retryCount < maxRetries) {
            console.log(
              `Retry attempt ${retryCount + 1} for subscription ID: ${subscriptionId}`
            );
            subscription = await this.findSubscription(
              subscriptionId,
              retryCount + 1,
              maxRetries
            );
          } else {
            console.log(`Failed to retrieve subscription ID: ${subscriptionId}`);
          }
          break;
        default:
          console.log('Another problem occurred, maybe unrelated to Stripe.');
          break;
      }
    }

    return subscription;
  }

  public async upsertProductRecord(product: Stripe.Product) {
    const productData = {
      id: product.id,
      active: product.active,
      name: product.name,
      description: product.description ?? null,
      image: product.images?.[0] ?? null,
      metadata: product.metadata
    };

    const { error: upsertError } = await this.supabaseAdmin
      .from('products')
      .upsert([productData]);
    if (upsertError) {
      console.log('webhook.upsertProductRecord(): upsertError', upsertError.message);
      return new Response(`Product insert/update failed: ${upsertError.message}`, {
        status: 500
      });
    }

    console.log(`Product inserted/updated: ${product.id}`);
  }

  public async upsertPriceRecord(
    price: Stripe.Price,
    retryCount = 0,
    maxRetries = 3
  ) {
    const priceData = {
      id: price.id,
      product_id: typeof price.product === 'string' ? price.product : '',
      active: price.active,
      currency: price.currency,
      type: price.type,
      unit_amount: price.unit_amount ?? null,
      interval: price.recurring?.interval ?? null,
      interval_count: price.recurring?.interval_count ?? null,
      trial_period_days: price.recurring?.trial_period_days ?? null
    };

    const { error: upsertError } = await this.supabaseAdmin
      .from('prices')
      .upsert([priceData]);

    if (upsertError?.message.includes('foreign key constraint')) {
      if (retryCount < maxRetries) {
        console.log(`Retry attempt ${retryCount + 1} for price ID: ${price.id}`);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        await this.upsertPriceRecord(price, retryCount + 1, maxRetries);
      } else {
        console.log(
          `webhook.upsertPriceRecord(): Price insert/update failed after ${maxRetries} retries: ${upsertError.message}`
        );
        return new Response(
          `Price insert/update failed after ${maxRetries} retries: ${upsertError.message}`,
          { status: 500 }
        );
      }
    } else if (upsertError) {
      console.log('webhook.upsertPriceRecord(): upsertError', upsertError.message);
      return new Response(`Price insert/update failed: ${upsertError.message}`, {
        status: 500
      });
    } else {
      console.log(`Price inserted/updated: ${price.id}`);
    }
  }

  public async deleteProductRecord(product: Stripe.Product) {
    const { error: deletionError } = await this.supabaseAdmin
      .from('products')
      .delete()
      .eq('id', product.id);
    if (deletionError) {
      console.log('webhook.deleteProductRecord(): deletionError', deletionError.message);
      return new Response(`Product deletion failed: ${deletionError.message}`, {
        status: 500
      });
    }
    console.log(`Product deleted: ${product.id}`);
  }

  public async deletePriceRecord(price: Stripe.Price) {
    const { error: deletionError } = await this.supabaseAdmin
      .from('prices')
      .delete()
      .eq('id', price.id);
    if (deletionError) {
      console.log('webhook.deletePriceRecord() : deletionError', deletionError.message);
      return new Response(`Price deletion failed: ${deletionError.message}`, {
        status: 500
      });
    }
    console.log(`Price deleted: ${price.id}`);
  }


  public async upsertCustomerToSupabase(uuid: string, customerId: string){
    const now = new Date()
    const { error: upsertError } = await this.supabaseAdmin
      .from("stripe_customers")
      .upsert([{ id: uuid, now, stripe_customer_id: customerId }])
  
    if (upsertError) {
      console.log(
        "webhook.upsertCustomerToSupabase() : upsertError",
        upsertError.message,
      )
      return new Response(
        `Supabase customer record creation failed: ${upsertError.message}`,
        { status: 500 },
      )
    }
  
    return customerId
  }
  
  public async createCustomerInStripe(uuid: string, email: string){
    const customerData = { metadata: { supabaseUUID: uuid }, email: email }
    const newCustomer = await this.stripe.customers.create(customerData)
    if (!newCustomer) {
      console.log("webhook.createCustomerInStripe() : customer creation failed ")
      return null;
    }
  
    return newCustomer.id
  }
  
  public async createOrRetrieveCustomer({
    email,
    uuid,
  }: {
    email: string
    uuid: string
  }) {
    // Check if the customer already exists in Supabase
    const { data: existingSupabaseCustomer, error: queryError } =
      await this.supabaseAdmin
        .from("stripe_customers")
        .select("*")
        .eq("id", uuid)
        .maybeSingle()
  
    if (queryError) {
      console.log(
        "webhook.createOrRetrieveCustomer() : queryError",
        queryError.message,
      )
      return new Response(
        `Supabase customer lookup failed: ${queryError.message}`,
        { status: 500 },
      )
    }
  
    // Retrieve the Stripe customer ID using the Supabase customer ID, with email fallback
    let stripeCustomerId: string | undefined
    if (existingSupabaseCustomer?.stripe_customer_id) {
      const existingStripeCustomer = await this.stripe.customers.retrieve(
        existingSupabaseCustomer.stripe_customer_id,
      )
      console.log(`Existing Stripe customer: ${existingStripeCustomer.id}`)
      stripeCustomerId = existingStripeCustomer?.id
    } else {
      // If Stripe ID is missing from Supabase, try to retrieve Stripe customer ID by email
      const stripeCustomers = await this.stripe.customers.list({ email: email })
      stripeCustomerId =
        stripeCustomers.data.length > 0 ? stripeCustomers.data[0].id : undefined
    }
  
    // If still no stripeCustomerId, create a new customer in Stripe
    const stripeIdToInsert = stripeCustomerId
      ? stripeCustomerId
      : await this.createCustomerInStripe(uuid, email)
    
      if (!stripeIdToInsert)
      return new Response("Stripe customer creation failed.", { status: 500 })
  
    if (existingSupabaseCustomer && stripeCustomerId) {
      // If Supabase has a record but doesn't match Stripe, update Supabase record
      if (existingSupabaseCustomer.stripe_customer_id !== stripeCustomerId) {
        const { error: updateError } = await this.supabaseAdmin
          .from("stripe_customers")
          .update({ stripe_customer_id: stripeCustomerId })
          .eq("id", uuid)
  
        if (updateError) {
          console.log(
            "webhook.createOrRetrieveCustomer() : updateError",
            updateError.message,
          )
          return new Response(
            `Supabase customer record update failed: ${updateError.message}`,
            { status: 500 },
          )
        }
        console.warn(
          `Supabase customer record mismatched Stripe ID. Supabase record updated.`,
        )
      }
      // If Supabase has a record and matches Stripe, return Stripe customer ID
      return stripeCustomerId
    } else {
      console.warn(
        `Supabase customer record was missing. A new record was created.`,
      )
  
      // If Supabase has no record, create a new record and return Stripe customer ID
      const upsertedStripeCustomer = await this.upsertCustomerToSupabase(
        uuid,
        stripeIdToInsert,
      )
      if (!upsertedStripeCustomer) {
        console.log(
          "webhook.createOrRetrieveCustomer() : upsertedStripeCustomer",
          upsertedStripeCustomer,
        )
        return new Response("Supabase customer record creation failed.", {
          status: 500,
        })
      }
  
      return upsertedStripeCustomer
    }
  }
  
  /**
   * Copies the billing details from the payment method to the customer object.
   */
  public async copyBillingDetailsToCustomer(
    uuid: string,
    payment_method: Stripe.PaymentMethod,
  ){
    //Todo: check this assertion
    const customer = payment_method.customer as string
    const { name, phone, address } = payment_method.billing_details
    if (!name || !phone || !address) return
    //@ts-ignore
    await stripe.customers.update(customer, { name, phone, address })
    const { error: updateError } = await this.supabaseAdmin
      .from("users")
      .update({
        billing_address: { ...address },
        payment_method: { ...payment_method[payment_method.type] },
      })
      .eq("id", uuid)
    if (updateError) {
      console.log(
        "webhook.copyBillingDetailsToCustomer() : updateError",
        updateError.message,
      )
      return new Response(`Customer update failed: ${updateError.message}`, {
        status: 400,
      })
    }
  }
  
  public async manageSubscriptionStatusChange(
    subscriptionId: string,
    customerId: string,
    createAction = false,
  ){
    console.log(
      `Subscription status change for [${subscriptionId}], customer: [${customerId}]`,
    )
    // Get customer's UUID from mapping table.
    const { data: customerData, error: noCustomerError } = await this.supabaseAdmin
      .from("stripe_customers")
      .select("user_id, stripe_customer_id")
      .eq("stripe_customer_id", customerId)
      .single()
  
    if (noCustomerError) {
      console.log(
        "webhook.manageSubscriptionStatusChange() : noCustomerError",
        noCustomerError.message,
      )
      return new Response(
        `Customer lookup failed: ${noCustomerError.message} - ${JSON.stringify(customerData)}`,
      )
    }
  
    const { user_id: uuid, stripe_customer_id: _ } = customerData
  
    let subscription: Stripe.Subscription | undefined = await this.findSubscription(subscriptionId)
  
    if (!subscription) {
      console.log(
        "webhook.manageSubscriptionStatusChange() : No subscription found",
      )
      return new Response("No subscription found", { status: 400 })
    }
  
    // Upsert the latest status of the subscription object.
    const subscriptionData = {
      id: subscription.id,
      user_id: uuid,
      metadata: subscription.metadata,
      status: subscription.status,
      price_id: subscription.items.data[0].price.id,
      //TODO check quantity on subscription
      // @ts-ignore
      quantity: subscription.quantity,
      cancel_at_period_end: subscription.cancel_at_period_end,
      cancel_at: subscription.cancel_at
        ? this.toDateTime(subscription.cancel_at).toISOString()
        : null,
      canceled_at: subscription.canceled_at
        ? this.toDateTime(subscription.canceled_at).toISOString()
        : null,
      current_period_start: this.toDateTime(
        subscription.current_period_start,
      ).toISOString(),
      current_period_end: this.toDateTime(
        subscription.current_period_end,
      ).toISOString(),
      created: this.toDateTime(subscription.created).toISOString(),
      ended_at: subscription.ended_at
        ? this.toDateTime(subscription.ended_at).toISOString()
        : null,
      trial_start: subscription.trial_start
        ? this.toDateTime(subscription.trial_start).toISOString()
        : null,
      trial_end: subscription.trial_end
        ? this.toDateTime(subscription.trial_end).toISOString()
        : null,
    }
  
    const { error: upsertError } = await this.supabaseAdmin
      .from("subscriptions")
      .upsert([subscriptionData])
    if (upsertError) {
      console.log(
        "webhook.manageSubscriptionStatusChange() : upsertError",
        upsertError.message,
      )
      return new Response("Unhandled relevant event!", { status: 400 })
    }
    console.log(
      `Inserted/updated subscription [${subscription.id}] for user [${uuid}]`,
    )
  
    // For a new subscription copy the billing details to the customer object.
    // NOTE: This is a costly operation and should happen at the very end.
    if (createAction && subscription.default_payment_method && uuid)
      //@ts-ignore
      await this.copyBillingDetailsToCustomer(
        uuid,
        subscription.default_payment_method as Stripe.PaymentMethod,
      )
  }
  
  private toDateTime(cancel_at: number): Date {
    return new Date(cancel_at * 1000)
  }

}