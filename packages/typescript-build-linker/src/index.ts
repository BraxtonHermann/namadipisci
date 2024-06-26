#!/usr/bin/env node

/**
 * typescript-build-linker
 * Link together TypeScript packages in a monorepo
 */

import * as path from 'path'
import * as t from 'io-ts'
import * as A from 'fp-ts/Array'
import * as E from 'fp-ts/Either'
import * as O from 'fp-ts/Option'
import * as T from 'fp-ts/Task'
import * as R from 'fp-ts/Record'
import * as S from 'fp-ts/Set'
import * as IO from 'fp-ts/IO'
import * as TE from 'fp-ts/TaskEither'
import * as Console from 'fp-ts/Console'
import * as D from 'io-ts-docopt'
import * as PathReporter from 'io-ts/lib/PathReporter'
import { withEncode } from 'io-ts-docopt'
import { getLastSemigroup } from 'fp-ts/lib/Semigroup'
import { sequenceS } from 'fp-ts/Apply'
import { pipe, flow, constVoid, constant, Endomorphism, identity } from 'fp-ts/function'
import { readFile as readFile_, writeFile as writeFile_ } from '@typescript-tools/lerna-utils'
import { stringifyJSON as stringifyJSON_ } from '@typescript-tools/stringify-json'
import { lernaPackages as lernaPackages_, PackageDiscoveryError } from '@typescript-tools/lerna-packages'
import { monorepoRoot as monorepoRoot_, MonorepoRootErr } from '@typescript-tools/monorepo-root'
import { TsConfig } from '@typescript-tools/io-ts/dist/lib/TsConfig'
import { dependencyGraph as dependencyGraph_, DependencyGraphError } from '@typescript-tools/dependency-graph'
import { withFallback } from 'io-ts-types/lib/withFallback'
import { LernaPackage } from '@typescript-tools/io-ts/dist/lib/LernaPackage'
import { StringifiedJSON } from '@typescript-tools/io-ts/dist/lib/StringifiedJSON'
import { Path } from '@typescript-tools/io-ts/dist/lib/Path'
import { trace } from '@strong-roots-capital/trace'
import relativePath from 'get-relative-path'
import Debug from 'debug'
import deepEqual from 'fast-deep-equal'
import { match } from 'ts-pattern'
import { eqString } from 'fp-ts/lib/Eq'

const debug = {
    cmd: Debug('link')
}

const docstring = `
Usage:
    typescript-build-linker [<repository>]

Options:
    <repository>    Path to monorepo root, defaults to cwd
`

const CommandLineOptions = withEncode(
    t.type({
        '<repository>': withFallback(t.string, process.cwd()),
    }),
    a => ({
        repository: a['<repository>'],
    })
)

type Err =
    | MonorepoRootErr
    | PackageDiscoveryError
    | DependencyGraphError
    | { type: 'docopt decode', error: string }
    | { type: 'unable to read file', filename: string, error: NodeJS.ErrnoException }
    | { type: 'unexpected file contents', filename: string, error: string }
    | { type: 'unable to stringify json', json: unknown, error: Error }
    | { type: 'unable to write file', filename: string, error: NodeJS.ErrnoException }

// Widens the type of a particular Err into Err
const err: Endomorphism<Err> = identity

const monorepoRoot = flow(monorepoRoot_, E.mapLeft(err), TE.fromEither)
const lernaPackages = flow(lernaPackages_, TE.mapLeft(err))

const dependencyGraph = (root?: string) => pipe(
    dependencyGraph_(root, { recursive: false }),
    TE.mapLeft(err)
)

const decodeDocopt = flow(
    D.decodeDocopt,
    E.mapLeft(errors => PathReporter.failure(errors).join('\n')),
    E.mapLeft(error => err({ type: 'docopt decode', error })),
    TE.fromEither
)

const readFile = (filename: string): TE.TaskEither<Err, string> => pipe(
    readFile_(filename),
    TE.mapLeft(error => err({ type: 'unable to read file', filename, error }))
)

const decodeFile = <C extends t.Mixed>(codec: C) => (filename: string) => (contents: string): TE.TaskEither<Err, C['_A']> => pipe(
    StringifiedJSON(codec).decode(contents),
    E.mapLeft(errors => PathReporter.failure(errors).join('\n')),
    E.mapLeft(error => err({ type: 'unexpected file contents', filename, error })),
    TE.fromEither
)

const stringifyJSON = (onError: (reason: unknown) => Error) => (json: unknown): TE.TaskEither<Err, string> => pipe(
    stringifyJSON_ (onError) (json),
    E.mapLeft(error => err({ type: 'unable to stringify json', json, error })),
    TE.fromEither
)

const writeFile = (filename: string) => (contents: string) => pipe(
    contents,
    trace(debug.cmd, `Writing file ${filename}`),
    writeFile_(filename),
    TE.mapLeft(error => err({ type: 'unable to write file', filename, error }))
)

const writeJson = (filename: string) => (value: unknown): TE.TaskEither<Err, void> => pipe(
    stringifyJSON (E.toError) (value),
    TE.chain(writeFile(filename))
)

const writeJsonIfModified = <A>(filename: string, original: A, desired: A): TE.TaskEither<Err, void> => pipe(
    O.fromPredicate ((value: A) => !deepEqual(original, value)) (desired),
    O.fold(
        constant(TE.right<Err, void>(undefined)),
        constant(writeJson (filename) (desired))
    )
)

const mapToRecord = <K extends string, V>(map: Map<K, V>): Record<K, V> => Array
    .from(map.entries())
    .reduce(
        (acc, [key, value]) => Object.assign(acc, { [key]: value }),
        {} as Record<K, V>
    )

const parentDirectory = (directory: string): O.Option<string> =>
    match<string, O.Option<string>>(directory)
        .with('.', constant(O.none))
        .otherwise(() => O.some(path.dirname(directory)))

const ancestors = (directory: string): [string, string][] => {

    const ancestors: [string, string][] = []
    let parent = parentDirectory(directory)

    while (O.isSome(parent)) {
        pipe(
            parent,
            O.map(parent_ => {
                ancestors.push([parent_, path.basename(directory)])
                directory = parent_
                parent = parentDirectory(parent_)
            })
        )
    }

    return ancestors
}

const linkChildrenPackages = (root: string) =>
    pipe(
        lernaPackages(root),
        // map parents to children
        TE.map(packages => R.fromFoldableMap(
            A.getMonoid<LernaPackage>(),
            A.array,
        ) (packages, pkg => [
            // map parent directories into relative paths from root
            root === path.dirname(pkg.location)
            // treat the case where package is a direct child of monorepo-root,
            // because relativePath returns '../<root>' most irregularly
                ? '.'
                : relativePath(root + '/', path.dirname(pkg.location)),
            [pkg]
        ])),
        // isolate the lerna package directory
        TE.map(R.map(A.map(pkg => path.basename(pkg.location)))),
        // create ancestor references
        TE.map(packagesByDirectory => R.fromFoldableMap(
            S.getUnionMonoid<string>(eqString),
            A.array,
        ) (
            pipe(
                Object.entries(packagesByDirectory),
                A.chain(([directory, packages]) => [
                    ...ancestors(directory),
                    ...packages.map(pkg => [directory, pkg]),
                ])
            ),
            ([directory, pkg]) => [directory, new Set([pkg])],
        )),
        // map set of children packages to set of children project references
        TE.map(R.map(packages => Array.from(packages).map(pkg => ({ path: pkg })))),
        // map to write instructions
        TE.map(R.mapWithIndex((parentDirectory, references) => {
            const tsconfigFile = path.resolve(root, parentDirectory, 'tsconfig.json')
            return pipe(
                readFile(tsconfigFile),
                TE.orElse(constant(TE.right('{}'))),
                TE.chain(decodeFile (TsConfig) (tsconfigFile)),
                // The `files: []` prevents an accidental invocation
                // of `tsc` without `-b` from trying to build the
                // entire directory as one compilation:
                // https://github.com/RyanCavanaugh/learn-a
                TE.chain(tsconfig => writeJsonIfModified(
                    path.resolve(root, tsconfigFile),
                    tsconfig,
                    Object.assign({ files: [] }, tsconfig, { references }),
                )),
            )
        })),

        // write in parallel
        TE.chain(sequenceS(TE.taskEither)),

        // return void on success
        TE.map(constVoid)
    )

const linkPackageDependencies = (root: string) =>
    pipe(
        // create map of package name to location (absolute path)
        lernaPackages(root),
        TE.map(packages => R.fromFoldableMap(
            getLastSemigroup<Path>(),
            A.array
        ) (packages, pkg => [pkg.name as string, pkg.location])),

        TE.chain(lernaPackages => pipe(
            dependencyGraph(root),
            TE.map(mapToRecord),
            TE.map(R.reduceWithIndex(
                {} as Record<Path, string[]>,
                (packageName, acc, dependencies) => Object.assign(
                    acc,
                    {
                        [lernaPackages[packageName]]:
                        dependencies
                            .map(d => d.location)
                            .map(p => path.relative(lernaPackages[packageName], p))
                            .map(path => ({ path }))
                    }
                )
            ))
        )),

        TE.map(R.mapWithIndex((packageDirectory, references) => {
            const tsconfigFile = path.resolve(packageDirectory, 'tsconfig.json')
            return pipe(
                readFile(tsconfigFile),
                TE.chain(decodeFile (TsConfig) (tsconfigFile)),
                TE.chain(tsconfig => writeJsonIfModified(
                    tsconfigFile,
                    tsconfig,
                    Object.assign({}, tsconfig, { references })
                ))
            )
        })),

        // write in parallel
        TE.chain(sequenceS(TE.taskEither)),

        // return void on success
        TE.map(constVoid)
    )

const exit = (code: 0 | 1): IO.IO<void> => () => process.exit(code)

const main: T.Task<void> =
    pipe(
        decodeDocopt(CommandLineOptions, docstring),
        TE.chain(options => monorepoRoot(options.repository)),
        TE.chain(root => pipe(
            [
                linkChildrenPackages(root),
                linkPackageDependencies(root),
            ],
            TE.sequenceArray
        )),
        TE.fold(
            flow(
                Console.error,
                IO.chain(() => exit(1)),
                T.fromIO
            ),
            constant(T.of(undefined))
        )
    )

main()

// Local Variables:
// mode: typescript
// End:
