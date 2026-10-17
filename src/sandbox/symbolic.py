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

def _same(a, b):
    difference = s.simplify(a - b)
    return True if difference == 0 else difference.equals(0)

def _solve(expr, symbol, roots):
    if isinstance(expr, list): raise ValueError('unsupported-expression')
    # Every claimed value must be a root, and the list must be the whole real solution set.
    for root in roots:
        answer = _compare(expr.subs(symbol, root), {symbol.name: symbol})
        if answer['state'] != 'verified': return answer
    if any(root.is_real is not True for root in roots): return {'state': 'none', 'reason': 'unsupported-complex-roots'}
    found = s.solveset(expr, symbol, s.S.Reals)
    if not isinstance(found, s.FiniteSet) or len(found) > 20 or any(root.is_real is not True for root in found):
        return {'state': 'none', 'reason': 'completeness-unresolved'}
    for root in found:
        matches = [_same(root, claimed) for claimed in roots]
        if True in matches: continue
        return {'state': 'none', 'reason': 'completeness-unresolved'} if None in matches else {'state': 'failed', 'reason': 'incomplete-solution-set'}
    return {'state': 'verified', 'reason': 'real-solution-set'}

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
            return json.dumps(_solve(expr, symbols[names[0]], roots))
        claimed = _parse(claimed_text, symbols)
        if isinstance(expr, list) or isinstance(claimed, list): raise ValueError('unsupported-expression')
        if claim['kind'] in ('equal', 'simplify'): difference = expr - claimed
        elif claim['kind'] == 'derivative': difference = s.diff(expr, symbols[names[0]]) - claimed
        elif claim['kind'] == 'integral': difference = expr - s.diff(claimed, symbols[names[0]])
        else: raise ValueError('unsupported-check')
        return json.dumps(_compare(difference, symbols))
    except BaseException as error:
        return json.dumps({'state': 'none', 'reason': 'interrupted' if isinstance(error, KeyboardInterrupt) else 'unsupported-expression'})

# Grading: a student's typed answer or worked solution against a reference answer. Text is turned into the
# expression syntax above, so _parse stays the only path from text to SymPy. Anything it cannot read stays unchecked.
import re, time

_ALIASES = {'ln': 'log', 'sen': 'sin', 'tg': 'tan', 'arcsin': 'asin', 'arccos': 'acos', 'arctan': 'atan', 'arctg': 'atan', 'arcsen': 'asin'}
_CALLS = {**{name: name for name in _FUNCTIONS}, **_ALIASES}
_GREEK = {'α': 'alpha', 'β': 'beta', 'γ': 'gamma', 'δ': 'delta', 'θ': 'theta', 'λ': 'lam', 'μ': 'mu', 'ρ': 'rho', 'σ': 'sigma', 'τ': 'tau', 'φ': 'phi', 'ω': 'omega'}
_NAMES = set(_GREEK.values()) | {'pi', 'oo', 'inf'}
_CHARS = str.maketrans({'−': '-', '–': '-', '—': '-', '·': '*', '⋅': '*', '×': '*', '∙': '*', '÷': '/', '≤': '<=', '⩽': '<=', '≥': '>=', '⩾': '>=', 'π': 'pi', '∞': 'oo', '∨': ' or ', '⇒': '\n', '⟹': '\n', '→': '\n', '⇔': '\n', '⟺': '\n', 'ℝ': 'R', **_GREEK})
_SUPERSCRIPTS = str.maketrans('⁰¹²³⁴⁵⁶⁷⁸⁹⁻', '0123456789-')
_LATEX = [
    (r'\\(?:left|right|displaystyle|quad|qquad|[,;:! ])', ' '), (r'\\begin\{[a-z*]*\}|\\end\{[a-z*]*\}|&', ' '),
    (r'\\\\', '\n'), (r'\\[()\[\]]|\$', ' '), (r'\\(?:cdot|times)(?![A-Za-z])', '*'), (r'\\div(?![A-Za-z])', '/'),
    (r'\\le(?:q|qslant)?(?![A-Za-z])', '<='), (r'\\ge(?:q|qslant)?(?![A-Za-z])', '>='), (r'\\pm(?![A-Za-z])', '±'),
    (r'\\infty(?![A-Za-z])', 'oo'), (r'\\in(?![A-Za-z])', '∈'), (r'\\cup(?![A-Za-z])', '∪'), (r'\\lor(?![A-Za-z])', ' or '),
    (r'\\(?:Rightarrow|Longrightarrow|implies|rightarrow|to|iff|Leftrightarrow|Longleftrightarrow)(?![A-Za-z])', '\n'),
    (r'\\mathbb\{R\}', 'R'), (r'\\\{', '{'), (r'\\\}', '}'),
]
_GROUPS = [
    (r'_\{([\w,]+)\}', lambda m: '_' + m.group(1).replace(',', '')),
    (r'\\sqrt\s*\[([^\[\]{}]*)\]\s*\{([^{}]*)\}', r'((\2)**(1/(\1)))'), (r'\\sqrt\s*\{([^{}]*)\}', r'sqrt(\1)'),
    (r'\\[dt]?frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}', r'((\1)/(\2))'), (r'\^\s*\{([^{}]*)\}', r'^(\1)'),
]

def _clean(text):
    """Unicode and LaTeX notation to plain lines; set braces stay as { }."""
    text = text.translate(_CHARS)
    text = re.sub(r'[⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+', lambda m: '^(' + m.group(0).translate(_SUPERSCRIPTS) + ')', text)
    text = re.sub(r'√\s*([A-Za-z]\w*|\d+(?:\.\d+)?)', r'sqrt(\1)', text).replace('√', 'sqrt')
    text = text.replace('+/-', '±').replace('+-', '±').replace('<=>', '\n').replace('=>', '\n').replace('->', '\n')
    for pattern, replacement in _LATEX: text = re.sub(pattern, replacement, text)
    for _ in range(30):
        before = text
        for pattern, replacement in _GROUPS: text = re.sub(pattern, replacement, text)
        if text == before: break
    text = re.sub(r'\\(' + '|'.join(sorted(_CALLS, key=len, reverse=True)) + r'|pi)(?![A-Za-z])', r' \1', text)
    if '\\' in text: raise ValueError('unsupported-latex')
    # A brace group with no comma groups an expression; with a comma it is a set.
    for _ in range(30):
        before = text
        text = re.sub(r'\{([^{},]*)\}', r'(\1)', text)
        if text == before: break
    return text

_TOKEN = re.compile(r'\s*(?:(?P<num>\d+(?:\.\d*)?(?:[eE][-+]?\d+)?|\.\d+)|(?P<name>[A-Za-z][A-Za-z0-9_]*)|(?P<op>\*\*|[-+*/^()]))')

def _words(word):
    """One identifier as tokens: a call, a constant, a variable, or two glued letters such as xy or sinx."""
    if word in _CALLS: return [('call', _CALLS[word])]
    # Lowercase e is Euler's number; uppercase E is a variable, as in E = mc^2.
    if word == 'e': return [('name', 'E')]
    if word == 'E': return [('name', 'E_')]
    if word in ('oo', 'inf'): return [('name', 'oo')]
    if word in _NAMES: return [('name', word)]
    if re.fullmatch(r'[A-Za-z](?:_?\d+|_[A-Za-z0-9]+)?', word): return [('name', word)]
    if word.isalpha() and len(word) == 2: return [token for letter in word for token in _words(letter)]
    for call in sorted(_CALLS, key=len, reverse=True):
        if word.startswith(call) and re.fullmatch(r'[A-Za-z]\d*', word[len(call):]):
            return [('call', _CALLS[call]), ('name', word[len(call):])]
    # A longer word is prose, not a product of single-letter variables.
    raise ValueError('prose')

def _syntax(text):
    """Student notation to expression syntax: implicit products (2x, 3(x+1), (a)(b)) and calls without parentheses (sin x)."""
    text = text.strip()
    tokens, position = [], 0
    while position < len(text):
        match = _TOKEN.match(text, position)
        if not match: raise ValueError('unsupported-expression')
        position = match.end()
        if match.group('num'): tokens.append(('num', match.group('num')))
        elif match.group('name'): tokens.extend(_words(match.group('name')))
        else: tokens.append(('op', match.group('op')))
        while position < len(text) and text[position].isspace(): position += 1
    out, ends, index = [], None, 0
    while index < len(tokens):
        kind, value = tokens[index]
        if kind == 'call':
            following = tokens[index + 1] if index + 1 < len(tokens) else None
            if ends: out.append('*')
            if following == ('op', '('): out.append(value); ends = None
            elif following and following[0] in ('num', 'name'): out.append(value + '(' + following[1] + ')'); index += 1; ends = 'value'
            else: raise ValueError('unsupported-expression')
        elif kind in ('num', 'name'):
            if ends == 'num' and kind == 'num': raise ValueError('unsupported-expression')
            if ends: out.append('*')
            out.append(value); ends = kind if kind == 'num' else 'value'
        elif value == '(':
            if ends: out.append('*')
            out.append(value); ends = None
        elif value == ')': out.append(value); ends = 'value'
        else: out.append(value); ends = None
        index += 1
    if not out: raise ValueError('unsupported-expression')
    return ' '.join(out)

class _Symbols(dict):
    """Real symbols made on first use, shared by the answer and the reference."""
    def __contains__(self, name):
        if name in ('pi', 'E', 'oo'): return True
        if not isinstance(name, str) or not name.isidentifier() or name.startswith('_') or len(name) > 32: return False
        if not dict.__contains__(self, name):
            if len(self) >= 8: raise ValueError('unsupported-variables')
            dict.__setitem__(self, name, s.Symbol(name, real=True))
        return True
    def __getitem__(self, name):
        if name == 'pi': return s.pi
        if name == 'E': return s.E
        if name == 'oo': return s.oo
        return dict.__getitem__(self, name)

def _depth_split(text, pattern):
    """Splits at matches of pattern that sit outside any bracket."""
    parts, depth, start, index, found = [], 0, 0, 0, []
    while index < len(text):
        char = text[index]
        if char in '([{': depth += 1
        elif char in ')]}': depth -= 1
        if depth == 0:
            match = re.compile(pattern).match(text, index)
            if match and match.end() > index:
                parts.append(text[start:index]); found.append(match.group(0).strip()); start = index = match.end()
                continue
        index += 1
    parts.append(text[start:])
    return parts, found

def _expr(text, symbols, infinite=False):
    value = _parse(_syntax(text), symbols)
    if isinstance(value, list): raise ValueError('unsupported-expression')
    if not infinite and value.has(s.oo, -s.oo, s.zoo, s.nan): raise ValueError('unsupported-infinity')
    return value

def _values(text, symbols):
    """One value, or the two values of a ±."""
    if text.count('±') > 1: raise ValueError('unsupported-expression')
    if '±' in text: return [_expr(text.replace('±', sign, 1), symbols) for sign in ('+', '-')]
    return [_expr(text, symbols)]

def _set(text, symbols):
    """Intervals ([a, b), ]a, b[, (-oo, 2]), finite sets {a, b}, R, and their unions. None when text is no set."""
    text = text.strip()
    parts, joins = _depth_split(text, r'\s*(?:∪|\bU\b)\s*')
    if joins: return s.Union(*[_set_or_fail(part, symbols) for part in parts])
    if text == 'R': return s.S.Reals
    if text.startswith('{') and text.endswith('}'):
        items, _ = _depth_split(text[1:-1], r'\s*,\s*')
        return s.FiniteSet(*[value for item in items for value in _values(item, symbols)])
    match = re.fullmatch(r'([\[\](])(.*)([\])\[])', text)
    if not match: return None
    items, _ = _depth_split(match.group(2), r'\s*,\s*')
    if len(items) != 2: return None
    low, high = (_expr(item, symbols, infinite=True) for item in items)
    if not (low.is_real or low == -s.oo) or not (high.is_real or high == s.oo): raise ValueError('unsupported-interval')
    return s.Interval(low, high, left_open=match.group(1) != '[', right_open=match.group(3) != ']')

def _set_or_fail(text, symbols):
    value = _set(text, symbols)
    if value is None: raise ValueError('unsupported-set')
    return value

def _variable(text, symbols):
    """The unknown an equation names; x1, x_2 and x_12 all name x."""
    value = _expr(text, symbols)
    if not isinstance(value, s.Symbol): raise ValueError('unsupported-variable')
    base = re.fullmatch(r'([A-Za-z])_?\d+', value.name)
    return symbols[base.group(1)] if base and base.group(1) in symbols else value

_RELATIONS = r'\s*(?:<=|>=|!=|==|=|<|>|≠)\s*'
_OPERATORS = {'<': s.Lt, '<=': s.Le, '>': s.Gt, '>=': s.Ge}
# A label names what a line computes, such as f(x), f'(x) or y': its own value is not part of the mathematics.
_LABEL = re.compile(r"\s*([A-Za-z]\w*)'*\s*\(\s*(-?[\w.]+(?:\s*,\s*-?[\w.]+)*)\s*\)\s*")

def _label(text):
    if "'" in text: return True
    match = _LABEL.fullmatch(text)
    # x(x+1) is a product; f(x) and f(2) name a value. A name that occurs in its own arguments is a product.
    return bool(match) and match.group(1) not in _CALLS and match.group(1) not in re.findall(r'[A-Za-z]\w*', match.group(2))

def _strip(line):
    line = re.sub(r'^\s*(?:[-*•]\s+|\d+[.)]\s+|[a-z][.)]\s+)', '', line).strip()
    # Leading words: "Quindi", "so", "Risposta:", "the answer is". A single ASCII letter is a variable, not a word.
    while True:
        match = re.match(r"([^\W\d_]+)\s*:\s*|([^\W\d_]{2,}|[^\W\d_A-Za-z])\s+(?=[^\s=<>+*/^)\]])", line)
        if not match: break
        word = (match.group(1) or match.group(2))
        if word in _CALLS or word in _NAMES: break
        line = line[match.end():]
    return line.strip().rstrip('.,;:').strip()

def _relations(parts, found, symbols):
    """1 < x <= 3 or 2x + 3 > 7, as the real solution set of one unknown."""
    values = [_expr(part, symbols) for part in parts]
    free = set().union(*[value.free_symbols for value in values])
    if len(free) != 1: return None
    unknown = free.pop()
    solved = s.S.Reals
    for index, operator in enumerate(found):
        relation = _OPERATORS[operator](values[index], values[index + 1])
        if relation is s.S.true: continue
        if relation is s.S.false: return {'kind': 'set', 'unknown': unknown, 'set': s.S.EmptySet}
        solved = s.Intersection(solved, s.solveset(relation, unknown, s.S.Reals))
    return {'kind': 'set', 'unknown': unknown, 'set': solved}

def _single(text, symbols):
    if '∈' in text:
        left, right = text.split('∈', 1)
        return {'kind': 'set', 'unknown': _variable(left, symbols), 'set': _set_or_fail(right, symbols)}
    parts, found = _depth_split(text, _RELATIONS)
    if any(operator in ('!=', '==', '≠') for operator in found): raise ValueError('unsupported-relation')
    if not found:
        written = _set(text, symbols)
        if written is not None: return {'kind': 'set', 'unknown': None, 'set': written}
        values = _values(text, symbols)
        return {'kind': 'set', 'unknown': None, 'set': s.FiniteSet(*values)} if len(values) > 1 else {'kind': 'expr', 'value': values[0]}
    if set(found) == {'='}:
        if not parts[0].strip():
            return {'kind': 'more', 'values': [_expr(part, symbols) for part in parts[1:]]}
        if len(parts) > 2 or _label(parts[0]):
            return {'kind': 'chain', 'label': re.sub(r'\s+', '', parts[0]), 'values': [_expr(part, symbols) for part in parts[1:]]}
        left = _expr(parts[0], symbols)
        written = _set(parts[1], symbols)
        if written is not None or '±' in parts[1]:
            return {'kind': 'set', 'unknown': _variable(parts[0], symbols), 'set': written if written is not None else s.FiniteSet(*_values(parts[1], symbols))}
        return {'kind': 'eq', 'left': left, 'right': _expr(parts[1], symbols)}
    if '=' in found: raise ValueError('unsupported-relation')
    return _relations(parts, found, symbols)

def _statement(line, symbols):
    """One line of the student's work as an expression, an equation, a solution set or a chain of equal values."""
    text = _strip(line)
    if not text or len(text) > 500: return None
    # An Italian decimal comma: 0,5. With a semicolon present, the semicolon separates and every comma is decimal.
    if ';' in text: text = re.sub(r'(?<=\d),(?=\d)', '.', text).replace(';', ',')
    else:
        pieces, _ = _depth_split(text, r'(?<=\d),(?=\d)')
        text = '.'.join(pieces)
    pieces, _ = _depth_split(text, r'\s*,\s*|(?<=[\w)\]}])\s+(?:or|o|oppure|e|ed|and)\s+(?=[\w(\[{\-+])')
    if len(pieces) == 1: return _single(text, symbols)
    values, unknown, solved = [], None, None
    for piece in pieces:
        parts, found = _depth_split(piece, _RELATIONS)
        if not found: values += _values(piece, symbols); continue
        if found == ['=']:
            named = _variable(parts[0], symbols)
            if unknown is not None and named != unknown: raise ValueError('unsupported-system')
            unknown = named
            values += _values(parts[1], symbols)
            continue
        if '=' in found or any(operator in ('!=', '==', '≠') for operator in found): raise ValueError('unsupported-relation')
        part = _relations(parts, found, symbols)
        if part is None or (unknown is not None and part['unknown'] != unknown): raise ValueError('unsupported-system')
        unknown = part['unknown']
        solved = part['set'] if solved is None else s.Union(solved, part['set'])
    if solved is not None and values: raise ValueError('unsupported-system')
    return {'kind': 'set', 'unknown': unknown, 'set': solved if solved is not None else s.FiniteSet(*values)}

def _lines(text):
    return [line for line in _clean(text).split('\n') if line.strip()][:40]

def _read(line, symbols):
    try: return _statement(line, symbols)
    except Exception: return None

def _truth(answer):
    return True if answer is True or answer is s.S.true else False if answer is False or answer is s.S.false else None

def _same_value(a, b):
    """True, False, or None when SymPy cannot tell. Rounding (1.41 for sqrt(2)) is never called a mistake here."""
    difference = a - b
    if difference.is_number:
        exact = _compare(difference, {})
        if exact['state'] == 'verified': return True
        if exact['state'] != 'failed': return None
        if a.is_number and b.is_number:
            left, right = complex(a.evalf()), complex(b.evalf())
            return None if abs(left - right) <= 0.01 * max(abs(left), abs(right)) else False
        return False
    found = _compare(difference, {symbol.name: symbol for symbol in difference.free_symbols})
    if found['state'] == 'failed' and _positive_equal(difference): return None
    return {'verified': True, 'failed': False}.get(found['state'])

def _positive_equal(difference):
    """Equal once every variable is positive, as log(xy) and log(x) + log(y) are: then the grader decides."""
    positive = {symbol: s.Symbol(symbol.name, positive=True) for symbol in difference.free_symbols}
    value = s.simplify(s.expand_log(difference.subs(positive), force=True))
    if value == 0: return True
    rng = random.Random(1947)
    for _ in range(20):
        try:
            if abs(complex(value.evalf(subs={symbol: rng.uniform(0.1, 4) for symbol in positive.values()}))) > 1e-7: return False
        except (ValueError, TypeError, ZeroDivisionError, OverflowError): return False
    return True

def _as_set(statement):
    """(unknown, real solution set), or None for statements that are not about one unknown."""
    if statement['kind'] == 'set': return statement['unknown'], statement['set']
    if statement['kind'] == 'eq':
        difference = statement['left'] - statement['right']
        if len(difference.free_symbols) != 1: return None
        unknown = next(iter(difference.free_symbols))
        return unknown, s.solveset(difference, unknown, s.S.Reals)
    return None

def _subset(a, b):
    return _truth(a.is_subset(b))

def _same_set(a, b):
    forward, backward = _subset(a, b), _subset(b, a)
    if forward and backward: return True
    if forward is False or backward is False: return False
    return None

def _proportional(a, b):
    """Two equations a = 0 and b = 0 are the same when a/b is a nonzero constant."""
    if a == 0 or b == 0: return None
    ratio = s.simplify(s.cancel(a / b))
    return True if ratio.is_number and ratio != 0 and ratio.is_finite else None

def _first(statement):
    return statement['values'][0] if statement['kind'] in ('chain', 'more') else statement.get('value')

def _last(statement):
    # "y = x^2 + 2x + 1" continued by "= (x+1)^2" continues its right side.
    if statement['kind'] == 'eq': return statement['right']
    return statement['values'][-1] if statement['kind'] in ('chain', 'more') else statement.get('value')

def _follows(previous, current, origins):
    """Whether current follows from previous: True, False (a real mistake), or None (not comparable or undecided)."""
    # Two bare expressions on separate lines may be a function and its derivative, so only "=" links values.
    if current['kind'] == 'more' or (current['kind'] == 'chain' and previous['kind'] == 'chain' and current['label'] == previous['label']):
        return _linked(_last(previous), _first(current))
    if previous['kind'] == 'eq' and current['kind'] == 'eq' and _proportional(previous['left'] - previous['right'], current['left'] - current['right']): return True
    before, after = _as_set(previous), _as_set(current)
    if not before or not after: return None
    if before[0] is not None and after[0] is not None and before[0] != after[0]: return None
    kept = _subset(before[1], after[1])
    if kept is not False: return kept
    # Losing a solution is a mistake; dropping one that squaring added (not a solution of the first line) is not.
    origin = origins.get(before[0] if before[0] is not None else after[0])
    if origin is None: return False
    return _subset(origin, after[1])

def _inner(statement):
    """A chain whose own values disagree, such as 3*4 + 1 = 12: the index of the wrong value, or None."""
    if statement['kind'] not in ('chain', 'more'): return None
    values = statement['values']
    for index in range(1, len(values)):
        if _linked(values[index - 1], values[index]) is False: return index
    return None

def _linked(a, b):
    """Two values joined by "=" in the work. A bare variable (x = y = 0) or a substitution (v = s/t = 100/20) is not compared."""
    if a is None or b is None or isinstance(a, s.Symbol) or isinstance(b, s.Symbol) or a.free_symbols != b.free_symbols: return None
    return _same_value(a, b)

def _final_value(statement):
    if statement['kind'] in ('chain', 'more', 'expr'): return {'kind': 'expr', 'value': _last(statement)}
    if statement['kind'] == 'eq' and isinstance(statement['left'], s.Symbol) and not statement['right'].has(statement['left']):
        if statement['right'].free_symbols: return {'kind': 'assign', 'unknown': statement['left'], 'value': statement['right']}
        return {'kind': 'set', 'unknown': statement['left'], 'set': s.FiniteSet(statement['right'])}
    solved = _as_set(statement)
    if solved: return {'kind': 'set', 'unknown': solved[0], 'set': solved[1]}
    return statement

def _numbers(a, b):
    try:
        if a.is_number and b.is_number and a.is_real and b.is_real: return [float(a), float(b)]
    except (TypeError, ValueError, OverflowError): pass
    return None

def _final(answer, reference):
    """The student's final answer against the reference; numbers carries two plain values so core applies its own tolerance."""
    a, b = _final_value(answer), _final_value(reference)
    if a['kind'] == 'assign' and b['kind'] == 'assign' and a['unknown'] != b['unknown']: return {'state': 'none', 'reason': 'different-unknowns'}
    if a['kind'] in ('expr', 'assign') and b['kind'] in ('expr', 'assign'):
        same = _same_value(a['value'], b['value'])
        numbers = _numbers(a['value'], b['value'])
        if same is None and numbers: same = False
        # 5 m/s against 5, or 2y + 1 against 2x + 1: different names are for the grader, not a mismatch.
        if same is False and a['value'].free_symbols != b['value'].free_symbols: same = None
        result = {'state': {True: 'verified', False: 'failed'}.get(same, 'none'), 'reason': 'expression'}
        if numbers and same is False: result['numbers'] = numbers
        return result
    if a['kind'] == 'expr' and b['kind'] == 'set' and isinstance(b['set'], s.FiniteSet): a = {'kind': 'set', 'unknown': None, 'set': s.FiniteSet(a['value'])}
    if b['kind'] == 'expr' and a['kind'] == 'set' and isinstance(a['set'], s.FiniteSet): b = {'kind': 'set', 'unknown': None, 'set': s.FiniteSet(b['value'])}
    if a['kind'] == 'set' and b['kind'] == 'set':
        if a['unknown'] is not None and b['unknown'] is not None and a['unknown'] != b['unknown']: return {'state': 'none', 'reason': 'different-unknowns'}
        left, right = a['set'], b['set']
        if isinstance(left, s.FiniteSet) and isinstance(right, s.FiniteSet) and len(left) == 1 and len(right) == 1:
            numbers = _numbers(next(iter(left)), next(iter(right)))
            same = _same_value(next(iter(left)), next(iter(right)))
            if same is None and numbers: same = False
            result = {'state': {True: 'verified', False: 'failed'}.get(same, 'none'), 'reason': 'solution-set'}
            if numbers and same is False: result['numbers'] = numbers
            return result
        same = _same_set(left, right)
        if same is False and isinstance(left, s.FiniteSet) and isinstance(right, s.FiniteSet) and len(left) == len(right):
            # Rounded roots (1.41 for sqrt(2)) are for the grader to judge, not a mismatch.
            if all(any(_same_value(x, y) is not False for y in right) for x in left): same = None
        return {'state': {True: 'verified', False: 'failed'}.get(same, 'none'), 'reason': 'solution-set'}
    if a['kind'] in ('eq', 'assign') and b['kind'] in ('eq', 'assign') and _proportional(_zero(a), _zero(b)):
        return {'state': 'verified', 'reason': 'equation'}
    return {'state': 'none', 'reason': 'not-comparable'}

def _zero(value):
    """An equation as one side that equals zero."""
    return value['unknown'] - value['value'] if value['kind'] == 'assign' else value['left'] - value['right']

def check_grade(raw):
    """{answer, reference} -> the final answer's verdict and the first step of the answer that does not follow."""
    started = time.monotonic()
    report = {'final': {'state': 'none', 'reason': 'unsupported-expression'}, 'steps': 0}
    try:
        data = json.loads(raw)
        budget = min(float(data.get('budget', 4)), 8)
        symbols = _Symbols()
        # A worked reference ends with its result, as the answer does.
        reference_lines = _lines(data['reference'])
        reference = _read(reference_lines[-1], symbols) if reference_lines else None
        lines = _lines(data['answer'])
        steps = [(number, line, _read(line, symbols)) for number, line in enumerate(lines, 1)]
        read = [step for step in steps if step[2] is not None]
        report['steps'] = len(read)
        # The final answer is the last line, read as written; an unreadable last line leaves it unchecked.
        if reference is not None and steps and steps[-1][2] is not None:
            report['final'] = _final(steps[-1][2], reference)
        origins, previous = {}, None
        for number, line, statement in read:
            if time.monotonic() - started > budget: report['partial'] = True; break
            inner = _inner(statement)
            if inner is not None:
                report['firstWrong'] = {'index': number, 'previous': line.strip()[:500], 'step': line.strip()[:500]}
                break
            if previous is not None:
                verdict = _follows(previous[2], statement, origins)
                if verdict is False:
                    report['firstWrong'] = {'index': number, 'previous': previous[1].strip()[:500], 'step': line.strip()[:500]}
                    break
            solved = _as_set(statement)
            if solved and solved[0] is not None: origins.setdefault(solved[0], solved[1])
            previous = (number, line, statement)
        return json.dumps(report)
    except BaseException as error:
        report['final'] = {'state': 'none', 'reason': 'interrupted' if isinstance(error, KeyboardInterrupt) else 'unsupported-expression'}
        report.pop('firstWrong', None)
        return json.dumps(report)
