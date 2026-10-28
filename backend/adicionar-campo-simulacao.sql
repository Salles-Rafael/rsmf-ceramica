ALTER TABLE public.orders
ADD COLUMN IF NOT EXISTS is_simulated boolean NOT NULL DEFAULT false;
