import ast, json, math, random
import sympy as s

_FUNCTIONS = {name: getattr(s, name) for name in ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log', 'sqrt', 'Abs', 'sinh', 'cosh', 'tanh']}
_FUNCTIONS['abs'] = s.Abs

def _parse(text, symbols):
    if not isinstance(text, str) or not text.strip() or len(text) > 2000:
        raise ValueError('unsupported-expression')
    tree = ast.parse(text.replace('^', '**'), mode='eval')
    if len(list(ast.walk(tree))) > 150:
        raise ValueError('expression-too-large')
    def visit(node):
        if isinstance(node, ast.Expression): return visit(node.body)
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            if not math.isfinite(node.value) or abs(node.value) > 1e100: raise ValueError('unsupported-number')
            return s.Integer(node.value) if type(node.value) is int else s.Float(node.value)
        if isinstance(node, ast.Name):
            if node.id in symbols: return symbols[node.id]
            if node.id in ('pi', 'E', 'I'): return getattr(s, node.id)
            raise ValueError('unknown-symbol')
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = visit(node.operand)
            return -value if isinstance(node.op, ast.USub) else value
        if isinstance(node, ast.BinOp):
            a, b = visit(node.left), visit(node.right)
            if isinstance(node.op, ast.Add): return a + b
            if isinstance(node.op, ast.Sub): return a - b
            if isinstance(node.op, ast.Mult): return a * b
            if isinstance(node.op, ast.Div): return a / b
            if isinstance(node.op, ast.Pow):
                if b.is_number and (not b.is_real or abs(b) > 10000): raise ValueError('unsupported-power')
                return a ** b
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in _FUNCTIONS and not node.keywords and 1 <= len(node.args) <= 2:
            return _FUNCTIONS[node.func.id](*[visit(arg) for arg in node.args])
        if isinstance(node, (ast.List, ast.Tuple)) and len(node.elts) <= 20:
            return [visit(item) for item in node.elts]
        raise ValueError('unsupported-expression')
    return visit(tree)

def _compare(difference, symbols):
    value = s.simplify(difference)
    if value == 0: return {'state': 'verified', 'reason': 'symbolic'}
    equality = value.equals(0)
    if equality is True: return {'state': 'verified', 'reason': 'symbolic'}
    if equality is False: return {'state': 'failed', 'reason': 'symbolic'}
    if value.is_number and value.is_finite: return {'state': 'failed', 'reason': 'symbolic'}
    rng = random.Random(1947)
    tested = 0
    for _ in range(60):
        point = {symbol: rng.uniform(-4, 4) for symbol in symbols.values()}
        try:
            evaluated = complex(value.evalf(subs=point))
            if not math.isfinite(evaluated.real) or not math.isfinite(evaluated.imag): continue
            tested += 1
            if abs(evaluated) > 1e-7: return {'state': 'failed', 'reason': 'numeric-counterexample'}
            if tested == 20: return {'state': 'verified', 'reason': 'numeric-20-points'}
        except (ValueError, TypeError, ZeroDivisionError, OverflowError): continue
    return {'state': 'none', 'reason': 'indeterminate'}

def check_claim(raw):
    try:
        claim = json.loads(raw)
        names = claim.get('vars') or ['x']
        if not 1 <= len(names) <= 8 or any(not isinstance(name, str) or not name.isidentifier() or name.startswith('_') or len(name) > 32 for name in names): raise ValueError('unsupported-variables')
        symbols = {name: s.Symbol(name, real=True) for name in names}
        expr = _parse(claim['expr'], symbols)
        claimed_text = claim['claimed']
        if claim['kind'] == 'solve':
            if len(names) != 1: raise ValueError('unsupported-multivariate-solve')
            roots = _parse(claimed_text if claimed_text.strip().startswith('[') else '[' + claimed_text + ']', symbols)
            if not isinstance(roots, list) or not roots: raise ValueError('unsupported-roots')
            for root in roots:
                answer = _compare(expr.subs(symbols[names[0]], root), symbols)
                if answer['state'] != 'verified': return json.dumps(answer)
            return json.dumps({'state': 'verified', 'reason': 'roots-substituted'})
        claimed = _parse(claimed_text, symbols)
        if isinstance(expr, list) or isinstance(claimed, list): raise ValueError('unsupported-expression')
        if claim['kind'] in ('equal', 'simplify'): difference = expr - claimed
        elif claim['kind'] == 'derivative': difference = s.diff(expr, symbols[names[0]]) - claimed
        elif claim['kind'] == 'integral': difference = expr - s.diff(claimed, symbols[names[0]])
        else: raise ValueError('unsupported-check')
        return json.dumps(_compare(difference, symbols))
    except BaseException as error:
        return json.dumps({'state': 'none', 'reason': 'interrupted' if isinstance(error, KeyboardInterrupt) else 'unsupported-expression'})
