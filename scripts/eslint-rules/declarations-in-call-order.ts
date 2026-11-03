import type { Rule } from 'eslint';
import ts from 'typescript';

/** A misplaced declaration: where it is, and what belongs there instead. */
export interface CallOrderViolation {
  line: number;
  column: number;
  found: string;
  expected: string;
  order: string[];
}

interface Unit {
  nodes: ts.Statement[];
  names: string[];
  kind: 'type' | 'value' | 'statement';
  references: Reference[];
  derivedFrom?: Unit;
}

type UnitLookup = (reference: Reference) => Unit | undefined;

interface Reference {
  name: string;
  position: number;
  atLoad: boolean;
  inType: boolean;
  inTypeof: boolean;
}

/**
 * A module reads top-down in the order its code runs. The entry point comes first, then each
 * callee straight after its first caller, depth first. Types and interfaces go at the top, except
 * one taken from a value (`z.infer<typeof schema>`), which sits right after that value. Statements
 * that run at load go last. In a class, fields, the constructor and static members come first,
 * then the public methods, each private one after the first method that calls it.
 *
 * Anything read while the module loads stays above what reads it, including a constant read by a
 * callback that runs at import, as in `byRole(() => stepConfigSchema)`; below it, the import throws.
 * For that reason the rule only reports: a reorder can be valid TypeScript and still throw at
 * import, which only the tests can tell.
 */
export const declarationsInCallOrder: Rule.RuleModule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Declarations follow call order: each callee after its first caller.' },
    messages: {
      outOfOrder:
        '`{{found}}` is out of call order: `{{expected}}` belongs here. Expected order: {{order}}.',
    },
    schema: [],
  },
  create(context) {
    return {
      Program() {
        for (const violation of callOrderViolations(context.sourceCode.text)) {
          context.report({
            loc: { line: violation.line, column: violation.column },
            messageId: 'outOfOrder',
            data: { ...violation, order: violation.order.join(', ') },
          });
        }
      },
    };
  },
};

/** The first misplaced declaration of the module, and of each class in it. */
export function callOrderViolations(text: string): CallOrderViolation[] {
  const source = ts.createSourceFile('module.ts', text, ts.ScriptTarget.Latest, true);
  const units = groupUnits(source.statements.filter((node) => !ts.isImportDeclaration(node)));
  const violations: CallOrderViolation[] = [];
  const moduleViolation = firstMisplaced(source, units, orderUnits(units), unitName);
  if (moduleViolation) violations.push(moduleViolation);
  for (const node of source.statements) {
    if (!ts.isClassDeclaration(node)) continue;
    const members = [...node.members];
    const classViolation = firstMisplaced(source, members, orderMembers(members), memberName);
    if (classViolation) violations.push(classViolation);
  }
  return violations;
}

function groupUnits(statements: ts.Statement[]): Unit[] {
  const units: Unit[] = [];
  const byName = new Map<string, Unit>();
  for (const node of statements) {
    const names = declaredNames(node);
    const kind = unitKind(node);
    const existing = names.map((name) => byName.get(name)).find(Boolean);
    if (existing && kind !== 'statement') {
      existing.nodes.push(node);
      if (kind === 'value') existing.kind = 'value';
      continue;
    }
    const unit: Unit = { nodes: [node], names, kind, references: [] };
    units.push(unit);
    for (const name of names) byName.set(name, unit);
  }
  const localNames = new Set(byName.keys());
  for (const unit of units) {
    unit.references = unit.nodes
      .flatMap((node) => referencesIn(node, localNames))
      .sort((a, b) => a.position - b.position);
  }
  return units;
}

function declaredNames(node: ts.Statement): string[] {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.flatMap((declaration) =>
      bindingNames(declaration.name),
    );
  }
  const name = (node as { name?: ts.Node }).name;
  return name && ts.isIdentifier(name) ? [name.text] : [];
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap((element) =>
    ts.isOmittedExpression(element) ? [] : bindingNames(element.name),
  );
}

function unitKind(node: ts.Statement): Unit['kind'] {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) return 'type';
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isVariableStatement(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return 'value';
  }
  return 'statement';
}

/**
 * Every use of a local name in `node`, in source order. A use is at load when it runs as the
 * module is imported: outside any function, or in a callback handed to code that runs then.
 */
function referencesIn(node: ts.Statement, localNames: Set<string>): Reference[] {
  const references: Reference[] = [];
  const own = new Set(declaredNames(node));
  const visit = (current: ts.Node, deferred: boolean, inType: boolean, inTypeof: boolean) => {
    if (ts.isIdentifier(current) && localNames.has(current.text) && !own.has(current.text)) {
      if (!isPropertyName(current)) {
        references.push({
          name: current.text,
          position: current.getStart(),
          atLoad: !deferred && !inType,
          inType: inType && !inTypeof,
          inTypeof,
        });
      }
    }
    const childDeferred = deferred || defersItsBody(current, deferred);
    const childInType = inType || isTypePosition(current);
    const childInTypeof = inTypeof || ts.isTypeQueryNode(current);
    ts.forEachChild(current, (child) => visit(child, childDeferred, childInType, childInTypeof));
  };
  if (ts.isFunctionDeclaration(node)) {
    ts.forEachChild(node, (child) => visit(child, true, false, false));
  } else {
    visit(node, false, unitKind(node) === 'type', false);
  }
  return references;
}

function isPropertyName(identifier: ts.Identifier) {
  const parent = identifier.parent;
  return (
    (ts.isPropertyAccessExpression(parent) && parent.name === identifier) ||
    (ts.isPropertyAssignment(parent) && parent.name === identifier) ||
    (ts.isPropertyDeclaration(parent) && parent.name === identifier) ||
    (ts.isMethodDeclaration(parent) && parent.name === identifier) ||
    (ts.isPropertySignature(parent) && parent.name === identifier) ||
    (ts.isQualifiedName(parent) && parent.right === identifier)
  );
}

/** Only a function that is a constant's whole value is sure not to run while the module loads. */
function defersItsBody(node: ts.Node, deferred: boolean) {
  const isFunctionExpression = ts.isFunctionExpression(node) || ts.isArrowFunction(node);
  const isConstantsValue =
    isFunctionExpression &&
    ts.isVariableDeclaration(node.parent) &&
    node.parent.initializer === node;
  return (
    isConstantsValue ||
    (deferred && isFunctionExpression) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node) ||
    (ts.isPropertyDeclaration(node) && !hasModifier(node, ts.SyntaxKind.StaticKeyword))
  );
}

function isTypePosition(node: ts.Node) {
  return (
    ts.isTypeNode(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    (ts.isHeritageClause(node) && node.token === ts.SyntaxKind.ImplementsKeyword)
  );
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind) {
  return ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === kind);
}

/** Types first, then values depth-first from the entry points, then load-time statements. */
function orderUnits(units: Unit[]): Unit[] {
  const unitNamed = new Map(units.flatMap((unit) => unit.names.map((name) => [name, unit])));
  const unitOf = (reference: Reference) => unitNamed.get(reference.name);
  attachDerivedTypes(units, unitOf);
  const values = orderValues(units, unitOf);
  const types = orderTypes(units, values, unitOf);
  const ordered = [...types];
  for (const value of values) {
    ordered.push(value, ...units.filter((unit) => unit.derivedFrom === value));
  }
  return [...ordered, ...units.filter((unit) => unit.kind === 'statement')];
}

/** A type taken from a value (`typeof x`, `z.infer<typeof schema>`) sits right after it. */
function attachDerivedTypes(units: Unit[], unitOf: UnitLookup) {
  for (const unit of units) {
    if (unit.kind !== 'type') continue;
    const source = unit.references.find(
      (reference) => reference.inTypeof && unitOf(reference)?.kind === 'value',
    );
    if (source) unit.derivedFrom = unitOf(source);
  }
}

function orderValues(units: Unit[], unitOf: UnitLookup): Unit[] {
  const values = units.filter((unit) => unit.kind === 'value');
  const valuesUsed = (unit: Unit, which: (reference: Reference) => boolean) =>
    unit.references
      .filter(which)
      .map(unitOf)
      .filter((used): used is Unit => used?.kind === 'value' && used !== unit);
  const callees = (unit: Unit) =>
    valuesUsed(unit, (reference) => !reference.inType && !reference.inTypeof);
  const readAtLoad = (unit: Unit) => valuesUsed(unit, (reference) => reference.atLoad);

  const ordered: Unit[] = [];
  const placed = new Set<Unit>();
  const placing = new Set<Unit>();
  const traced = new Set<Unit>();
  const place = (unit: Unit) => {
    if (placed.has(unit) || placing.has(unit)) return;
    placing.add(unit);
    for (const dependency of readAtLoad(unit)) placeBefore(dependency);
    placing.delete(unit);
    placed.add(unit);
    ordered.push(unit);
    for (const callee of callees(unit)) place(callee);
  };
  const placeBefore = (unit: Unit) => {
    if (placed.has(unit) || placing.has(unit)) return;
    if (!unit.nodes.every((node) => ts.isFunctionDeclaration(node))) return place(unit);
    if (traced.has(unit)) return;
    traced.add(unit);
    for (const callee of callees(unit)) placeBefore(callee);
  };

  const called = new Set(values.flatMap(callees));
  for (const statement of units.filter((unit) => unit.kind === 'statement')) {
    for (const reference of statement.references) {
      const used = unitOf(reference);
      if (used) called.add(used);
    }
  }
  for (const entryPoint of values.filter((unit) => !called.has(unit))) place(entryPoint);
  for (const unit of values) place(unit);
  return ordered;
}

/** Types in the order the values first use them; a type another type uses goes after it. */
function orderTypes(units: Unit[], values: Unit[], unitOf: UnitLookup): Unit[] {
  const types = units.filter((unit) => unit.kind === 'type' && !unit.derivedFrom);
  const typesUsed = (unit: Unit) =>
    unit.references
      .map(unitOf)
      .filter((used): used is Unit => !!used && types.includes(used) && used !== unit);
  const firstUse = new Map<Unit, number>();
  values.forEach((value, index) => {
    for (const used of typesUsed(value)) if (!firstUse.has(used)) firstUse.set(used, index);
  });
  const usedByAType = new Set(types.flatMap(typesUsed));
  const roots = types
    .filter((unit) => !usedByAType.has(unit))
    .sort((a, b) => (firstUse.get(a) ?? -1) - (firstUse.get(b) ?? -1));

  const ordered: Unit[] = [];
  const place = (unit: Unit) => {
    if (ordered.includes(unit)) return;
    ordered.push(unit);
    for (const used of typesUsed(unit)) place(used);
  };
  for (const root of roots) place(root);
  for (const unit of types) place(unit);
  return ordered;
}

/** Fields, the constructor and static members first; each private method after its first caller. */
function orderMembers(members: ts.ClassElement[]): ts.ClassElement[] {
  const isMethod = (member: ts.ClassElement) =>
    ts.isMethodDeclaration(member) || ts.isGetAccessor(member) || ts.isSetAccessor(member);
  const isStatic = (member: ts.ClassElement) => hasModifier(member, ts.SyntaxKind.StaticKeyword);
  const isPrivate = (member: ts.ClassElement) =>
    hasModifier(member, ts.SyntaxKind.PrivateKeyword) ||
    (!!member.name && ts.isPrivateIdentifier(member.name));
  const methods = members.filter((member) => isMethod(member) && !isStatic(member));
  const privateMethods = methods.filter(isPrivate);
  const privateCalls = (member: ts.ClassElement) => {
    const calls: { member: ts.ClassElement; position: number }[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAccessExpression(node) &&
        node.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        for (const method of privateMethods) {
          if (memberName(method) === node.name.text)
            calls.push({ member: method, position: node.getStart() });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(member);
    return calls.sort((a, b) => a.position - b.position).map((call) => call.member);
  };

  const ordered: ts.ClassElement[] = [];
  const place = (member: ts.ClassElement) => {
    if (ordered.includes(member)) return;
    ordered.push(member);
    for (const callee of privateCalls(member)) place(callee);
  };
  const isConstructor = (member: ts.ClassElement) => ts.isConstructorDeclaration(member);
  for (const member of members.filter((member) => !isMethod(member) && !isConstructor(member)))
    place(member);
  for (const member of members.filter(isConstructor)) place(member);
  for (const member of members.filter((member) => isMethod(member) && isStatic(member)))
    place(member);
  for (const method of methods.filter((method) => !isPrivate(method))) place(method);
  for (const method of methods) place(method);
  return ordered;
}

function firstMisplaced<T>(
  source: ts.SourceFile,
  actual: T[],
  expected: T[],
  nameOf: (item: T) => string,
): CallOrderViolation | undefined {
  const index = actual.findIndex((item, position) => item !== expected[position]);
  if (index === -1) return undefined;
  const found = actual[index];
  const { line, character } = source.getLineAndCharacterOfPosition(startOf(found));
  return {
    line: line + 1,
    column: character,
    found: nameOf(found),
    expected: nameOf(expected[index]),
    order: expected.map(nameOf),
  };
}

function startOf(item: unknown) {
  const unit = item as Partial<Unit>;
  return unit.nodes ? unit.nodes[0].getStart() : (item as ts.Node).getStart();
}

function unitName(unit: Unit) {
  return unit.names[0] ?? 'statement';
}

function memberName(member: ts.ClassElement) {
  if (ts.isConstructorDeclaration(member)) return 'constructor';
  const name = member.name;
  return name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) ? name.text : 'member';
}
