# Document preview test fixtures

`legacy-word.doc` is the unchanged `__tests__/data/test09.doc` fixture from
[morungos/node-word-extractor](https://github.com/morungos/node-word-extractor/blob/d971d9f69056245ae129bd2ce31436d518293854/__tests__/data/test09.doc),
commit `d971d9f69056245ae129bd2ce31436d518293854`. It is a short regression
document about a parenthesis character. Copyright (c) 2016-2021 Stuart Watt;
the upstream MIT license is included in `word-extractor-LICENSE.txt`.

SHA-256: `2d64b06b5168d41882d6b260a4ef3653614b73e4397c8d711922ba175b459032`.

`modern-word.docx` is an original minimal Office Open XML fixture made for
Harbor. It contains a title, Unicode text, and literal script-looking text.

`expanded-limit.docx` is an original bounded limit-test fixture. Its small ZIP
contains a document and 41 MiB of repetitive text, exceeding Harbor's 40 MiB
DOCX expansion limit. Tests require rejection before document extraction.

Tests use these local fixtures and require no network access.
