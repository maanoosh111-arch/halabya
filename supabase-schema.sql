-- Supabase SQL Schema for حلبية للمشويات والمأكولات
-- Run this in your Supabase SQL Editor when connecting Supabase persistence.

create table if not exists store_settings (
  id text primary key,
  is_open boolean not null default true,
  open_time text not null default '11:00 ص',
  close_time text not null default '02:00 ص',
  customer_note text not null default '',
  delivery_fee numeric not null default 25,
  transfer_number text not null default '0123456789',
  profit_reset_at timestamptz null,
  admin_pin_hash text null,
  updated_at timestamptz not null default now()
);

create table if not exists orders (
  id text primary key,
  order_code text not null unique,
  status text not null default 'Pending',
  rejection_reason text not null default '',
  is_archived boolean not null default false,
  is_deleted_from_archive boolean not null default false,
  is_paid boolean not null default false,
  customer_name text not null,
  customer_phone text not null,
  delivery_address text not null,
  delivery_notes text not null default '',
  payment_method text not null,
  sender_wallet_phone text not null default '',
  receipt_image text not null default '',
  items jsonb not null default '[]'::jsonb,
  subtotal numeric not null default 0,
  delivery_fee numeric not null default 0,
  grand_total numeric not null default 0,
  total_profit numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz null
);

create index if not exists idx_orders_created_at on orders (created_at desc);
create index if not exists idx_orders_status on orders (status);
create index if not exists idx_orders_customer_phone on orders (customer_phone);
