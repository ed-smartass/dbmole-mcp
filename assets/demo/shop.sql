-- Demo "shop" database for assets/dbmole-demo.tape. Loaded by assets/demo/dbmole-up.sh.
CREATE TABLE customers (
    id serial PRIMARY KEY,
    email text NOT NULL UNIQUE,
    name text NOT NULL,
    country char(2) NOT NULL,
    created_at timestamptz NOT NULL
);
CREATE TABLE products (
    id serial PRIMARY KEY,
    sku text NOT NULL UNIQUE,
    name text NOT NULL,
    category text NOT NULL,
    price numeric(10, 2) NOT NULL,
    stock int NOT NULL
);
CREATE TABLE orders (
    id bigserial PRIMARY KEY,
    customer_id int NOT NULL REFERENCES customers,
    status text NOT NULL,
    total numeric(12, 2) NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL
);
CREATE TABLE order_items (
    id bigserial PRIMARY KEY,
    order_id bigint NOT NULL REFERENCES orders,
    product_id int NOT NULL REFERENCES products,
    quantity int NOT NULL,
    unit_price numeric(10, 2) NOT NULL
);
CREATE TABLE payments (
    id bigserial PRIMARY KEY,
    order_id bigint NOT NULL REFERENCES orders,
    method text NOT NULL,
    amount numeric(12, 2) NOT NULL,
    status text NOT NULL,
    paid_at timestamptz NOT NULL
);

INSERT INTO customers (email, name, country, created_at)
SELECT 'customer' || g || '@example.com', 'Customer ' || g,
       (ARRAY['US', 'DE', 'GB', 'FR', 'NL', 'PL', 'ES', 'CA'])[1 + g % 8],
       now() - (g % 1000) * interval '1 day'
FROM generate_series(1, 20000) g;

INSERT INTO products (sku, name, category, price, stock)
SELECT 'SKU-' || lpad(g::text, 5, '0'), 'Product ' || g,
       (ARRAY['books', 'games', 'garden', 'kitchen', 'office', 'toys'])[1 + g % 6],
       round((5 + random() * 195)::numeric, 2), (random() * 500)::int
FROM generate_series(1, 1000) g;

INSERT INTO orders (customer_id, status, created_at)
SELECT 1 + (random() * 19999)::int,
       (ARRAY['paid', 'paid', 'paid', 'shipped', 'shipped', 'cancelled', 'refunded'])[1 + g % 7],
       now() - random() * interval '730 days'
FROM generate_series(1, 200000) g;

INSERT INTO order_items (order_id, product_id, quantity, unit_price)
SELECT o.id, 1 + (random() * 999)::int, 1 + (random() * 3)::int,
       round((5 + random() * 195)::numeric, 2)
FROM orders o, generate_series(1, 1 + (o.id % 4)::int);

UPDATE orders o SET total = s.total
FROM (SELECT order_id, sum(quantity * unit_price) AS total FROM order_items GROUP BY order_id) s
WHERE s.order_id = o.id;

INSERT INTO payments (order_id, method, amount, status, paid_at)
SELECT id, (ARRAY['card', 'card', 'paypal', 'bank_transfer'])[1 + id % 4], total,
       CASE WHEN status = 'refunded' THEN 'refunded' ELSE 'captured' END,
       created_at + interval '2 minutes'
FROM orders WHERE status <> 'cancelled';

CREATE INDEX ON orders (customer_id);
CREATE INDEX ON orders (created_at);
CREATE INDEX ON order_items (order_id);
CREATE INDEX ON payments (order_id);

CREATE VIEW daily_revenue AS
SELECT date_trunc('day', created_at)::date AS day, count(*) AS orders, sum(total) AS revenue
FROM orders WHERE status IN ('paid', 'shipped') GROUP BY 1;

CREATE VIEW top_customers AS
SELECT c.id, c.name, count(o.id) AS orders, sum(o.total) AS spent
FROM customers c JOIN orders o ON o.customer_id = c.id GROUP BY c.id, c.name;

ANALYZE;

CREATE ROLE reporter LOGIN PASSWORD 'demo';
GRANT CONNECT ON DATABASE shop TO reporter;
GRANT USAGE ON SCHEMA public TO reporter;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO reporter;
