"""Small, deterministic price/time-priority limit order book. All balances use integer cents."""
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation


def timestamp():
    return datetime.now(timezone.utc).isoformat()


def money(cents):
    return round(cents / 100, 2)


def cents(value):
    try:
        amount = Decimal(str(value))
    except InvalidOperation as exc:
        raise ValueError("Invalid price format") from exc
    if not amount.is_finite() or amount <= 0 or amount > 1000000:
        raise ValueError("Price must be between 0.01 and 1000000")
    scaled = amount * 100
    if scaled != scaled.to_integral_value():
        raise ValueError("Price can have at most two decimal places")
    return int(scaled)


class Exchange:
    def __init__(self, actors, data=None):
        if data:
            self.stocks = data["stocks"]
            self.accounts = data["accounts"]
            self.orders = data["orders"]
            self.trades = data["trades"]
            self.order_sequence = data.get("order_sequence", len(self.orders))
            self.trade_sequence = data.get("trade_sequence", len(self.trades))
        else:
            self.stocks = {
                "QH": {"name": "Qinghe Technology", "initial": 10000, "last": 10000, "volume": 0, "history": []},
                "YS": {"name": "Yuanshan Energy", "initial": 5000, "last": 5000, "volume": 0, "history": []},
            }
            self.accounts, self.orders, self.trades = {}, [], []
            self.order_sequence = self.trade_sequence = 0
        for symbol, name in {"QH": "Qinghe Technology", "YS": "Yuanshan Energy"}.items():
            self.stocks[symbol]["name"] = name
        self.started_at = (data or {}).get("started_at") or (
            self.orders[0]["created_at"] if self.orders else timestamp())
        # Older saved markets also get participant-level chart data from the trade ledger.
        orders_by_id = {order["id"]: order for order in self.orders}
        previous_prices = {symbol: stock["initial"] for symbol, stock in self.stocks.items()}
        for stock in self.stocks.values():
            stock["history"] = []
        for trade in self.trades:
            buy = orders_by_id.get(trade["buy_order_id"])
            sell = orders_by_id.get(trade["sell_order_id"])
            if buy and sell:
                aggressor = max((buy, sell), key=lambda order: order["sequence"])
                trade["aggressor_id"] = aggressor["actor_id"]
                trade["aggressor_side"] = aggressor["side"]
            price = cents(trade["price"])
            trade["price_change"] = money(price - previous_prices[trade["symbol"]])
            previous_prices[trade["symbol"]] = price
            self.stocks[trade["symbol"]]["history"].append(self.price_point(trade))
        for actor in ["adrian", *actors]:
            self.add_account(actor)
        if not data:
            self.add_account("opening_liquidity", opening=True)
            for symbol, stock in self.stocks.items():
                for spread in [.005, .015]:
                    self.place("opening_liquidity", symbol, "buy", "limit", 800,
                               money(round(stock["initial"] * (1-spread))))
                    self.place("opening_liquidity", symbol, "sell", "limit", 800,
                               money(round(stock["initial"] * (1+spread))))

    def add_account(self, actor, opening=False):
        if actor in self.accounts:
            return
        cash = 1_000_000_000 if opening else 10_000_000
        positions = {"QH": 10000, "YS": 10000} if opening else {"QH": 200, "YS": 400}
        self.accounts[actor] = {"cash": cash, "positions": positions,
                                "initial_equity": cash + sum(positions[s]*self.stocks[s]["initial"] for s in self.stocks)}

    def dump(self):
        return {"stocks": self.stocks, "accounts": self.accounts, "orders": self.orders,
                "trades": self.trades, "order_sequence": self.order_sequence,
                "trade_sequence": self.trade_sequence, "started_at": self.started_at}

    @staticmethod
    def price_point(trade):
        return {"trade_id": trade["id"], "time": trade["time"], "price": trade["price"],
                "volume": trade["quantity"], "buyer_id": trade["buyer_id"],
                "seller_id": trade["seller_id"], "aggressor_id": trade.get("aggressor_id"),
                "aggressor_side": trade.get("aggressor_side"),
                "price_change": trade["price_change"]}

    def active_orders(self, actor=None):
        return [o for o in self.orders if o["status"] in {"open", "partially_filled"}
                and o["remaining"] > 0 and (actor is None or o["actor_id"] == actor)]

    def account(self, actor, name=None):
        if actor not in self.accounts:
            raise ValueError("Trading account not found")
        raw = self.accounts[actor]
        reserved_cash = 0
        reserved_stock = {symbol: 0 for symbol in self.stocks}
        for order in self.active_orders(actor):
            if order["side"] == "buy" and order["order_type"] == "limit":
                reserved_cash += order["price"] * order["remaining"]
            elif order["side"] == "sell":
                reserved_stock[order["symbol"]] += order["remaining"]
        position_values = {s: raw["positions"][s]*self.stocks[s]["last"] for s in self.stocks}
        market_value = sum(position_values.values())
        equity = raw["cash"] + market_value
        return {"actor_id": actor, "name": name or actor, "cash": money(raw["cash"]),
                "available_cash": money(raw["cash"] - reserved_cash),
                "reserved_cash": money(reserved_cash), "positions": dict(raw["positions"]),
                "available_positions": {s: raw["positions"][s]-reserved_stock[s] for s in self.stocks},
                "reserved_positions": reserved_stock, "equity": money(equity),
                "initial_equity": money(raw["initial_equity"]),
                "pnl": money(equity-raw["initial_equity"]),
                "pnl_percent": round((equity-raw["initial_equity"]) / raw["initial_equity"] * 100, 4),
                "market_value": money(market_value),
                "position_values": {s: money(value) for s, value in position_values.items()},
                "system": actor == "opening_liquidity"}

    @staticmethod
    def public_order(order):
        filled = order["quantity"] - order["remaining"]
        return {key: order[key] for key in ["id", "actor_id", "symbol", "side", "order_type",
                "quantity", "remaining", "status", "created_at", "updated_at", "reason"]} | {
                "filled_quantity": filled,
                "limit_price": money(order["price"]) if order["price"] is not None else None,
                "average_fill_price": round(order["filled_value"]/filled/100, 4) if filled else None}

    def actor_orders(self, actor):
        return [self.public_order(order) for order in reversed(self.orders) if order["actor_id"] == actor]

    def book(self, symbol):
        result = {}
        for side, name in [("buy", "bids"), ("sell", "asks")]:
            levels = {}
            for order in self.active_orders():
                if order["symbol"] == symbol and order["side"] == side and order["order_type"] == "limit":
                    levels[order["price"]] = levels.get(order["price"], 0) + order["remaining"]
            result[name] = [{"price": money(price), "quantity": levels[price]}
                            for price in sorted(levels, reverse=side == "buy")[:10]]
        return result

    def place(self, actor, symbol, side, order_type, quantity, limit_price=None):
        symbol = symbol.strip().upper()
        if actor not in self.accounts:
            raise ValueError("Trading account not found")
        if symbol not in self.stocks or side not in {"buy", "sell"} or order_type not in {"limit", "market"}:
            raise ValueError("Invalid stock, side or order type")
        if type(quantity) is not int or not 1 <= quantity <= 10000:
            raise ValueError("Quantity must be an integer from 1 to 10000 shares")
        price = cents(limit_price) if order_type == "limit" else None
        if order_type == "market" and limit_price is not None:
            raise ValueError("Market orders must not specify a limit price")
        available = self.account(actor)
        available_cash = round(available["available_cash"] * 100)
        if side == "sell" and quantity > available["available_positions"][symbol]:
            raise ValueError("Insufficient available shares; open sell orders reserve shares")
        if side == "buy" and order_type == "limit" and quantity * price > available_cash:
            raise ValueError("Insufficient available cash; reduce the quantity or limit price, or cancel another buy order")
        if side == "buy" and order_type == "market" and available_cash <= 0:
            raise ValueError("No available cash")
        self.order_sequence += 1
        order = {"id": f"O{self.order_sequence:06d}", "sequence": self.order_sequence,
                 "actor_id": actor, "symbol": symbol, "side": side, "order_type": order_type,
                 "quantity": quantity, "remaining": quantity, "price": price,
                 "filled_value": 0, "status": "open", "created_at": timestamp(),
                 "updated_at": timestamp(), "reason": ""}
        self.orders.append(order)
        opposite = [o for o in self.active_orders() if o["symbol"] == symbol and o["side"] != side]
        opposite.sort(key=lambda o: (o["price"] if side == "buy" else -o["price"], o["sequence"]))
        fills = []
        for maker in opposite:
            if not order["remaining"]:
                break
            execution_price = maker["price"]
            if price is not None and ((side == "buy" and execution_price > price)
                                       or (side == "sell" and execution_price < price)):
                break
            if maker["actor_id"] == actor:
                order["reason"] = "Remainder cancelled to prevent self-trading"
                break
            fill = min(order["remaining"], maker["remaining"])
            if side == "buy" and order_type == "market":
                cash = round(self.account(actor)["available_cash"] * 100)
                fill = min(fill, cash // execution_price)
                if not fill:
                    order["reason"] = "Remainder cancelled because available cash is insufficient"
                    break
            buyer = order if side == "buy" else maker
            seller = maker if side == "buy" else order
            value = execution_price * fill
            buyer_account, seller_account = self.accounts[buyer["actor_id"]], self.accounts[seller["actor_id"]]
            buyer_account["cash"] -= value
            seller_account["cash"] += value
            buyer_account["positions"][symbol] += fill
            seller_account["positions"][symbol] -= fill
            for item in [order, maker]:
                item["remaining"] -= fill
                item["filled_value"] += value
                item["updated_at"] = timestamp()
                item["status"] = "filled" if item["remaining"] == 0 else "partially_filled"
            self.trade_sequence += 1
            trade = {"id": f"T{self.trade_sequence:06d}", "symbol": symbol,
                     "price": money(execution_price), "quantity": fill,
                     "buyer_id": buyer["actor_id"], "seller_id": seller["actor_id"],
                     "buy_order_id": buyer["id"], "sell_order_id": seller["id"], "time": timestamp(),
                     "aggressor_id": actor, "aggressor_side": side,
                     "price_change": money(execution_price - self.stocks[symbol]["last"])}
            self.trades.append(trade)
            fills.append(trade)
            stock = self.stocks[symbol]
            stock["last"], stock["volume"] = execution_price, stock["volume"] + fill
            stock["history"].append(self.price_point(trade))
        if order["remaining"] and (order_type == "market" or order["reason"]):
            order["status"] = "cancelled"
            if not order["reason"]:
                order["reason"] = "Unfilled remainder cancelled after immediate matching"
        order["updated_at"] = timestamp()
        return {"order": self.public_order(order), "fills": fills, "account": self.account(actor)}

    def cancel(self, actor, order_id):
        order = next((o for o in self.orders if o["id"] == order_id), None)
        if order is None or order["actor_id"] != actor:
            raise ValueError("You can cancel only your own orders")
        if order["status"] not in {"open", "partially_filled"}:
            raise ValueError("This order is already closed")
        order.update(status="cancelled", reason="Remaining quantity cancelled by the trader", updated_at=timestamp())
        return self.public_order(order)

    def snapshot(self, names=None):
        names = names or {}
        books = {symbol: self.book(symbol) for symbol in self.stocks}
        stocks = []
        for symbol, stock in self.stocks.items():
            book = books[symbol]
            change = stock["last"] - stock["initial"]
            stocks.append({"symbol": symbol, "name": stock["name"], "initial_price": money(stock["initial"]),
                           "started_at": self.started_at,
                           "last_price": money(stock["last"]), "change": money(change),
                           "change_percent": round(change / stock["initial"] * 100, 2),
                           "bid": book["bids"][0]["price"] if book["bids"] else None,
                           "ask": book["asks"][0]["price"] if book["asks"] else None,
                           "volume": stock["volume"], "history": stock["history"]})
        names = {**names, "opening_liquidity": "Opening liquidity"}
        return {"stocks": stocks, "books": books, "trades": self.trades[-100:][::-1],
                "accounts": [self.account(actor, names.get(actor)) for actor in self.accounts],
                "my_account": self.account("adrian", "Adrian"), "my_orders": self.actor_orders("adrian")}
