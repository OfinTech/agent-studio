# Ofintech report template

This is the explicitly configured Report Agent template, not a workflow creation example.

- Logo: the unmodified navy PNG from [Ofintech's website](https://ofintech.co/ofin-logo-1.png), downloaded 2026-09-15. The website's footer bundle references this asset. Primary colour `#142366` comes from the logo.
- Layout: A4, Ofintech logo on every page, navy section headings, page counts, website footer, and consistent diagram/plot/table styles.
- Parameters: `title`, `subtitle`, `report_date`, `executive_summary`, `body`, `sources`. Each is a LaTeX string; body content varies with the report brief.
- Compiler: `tectonic-0.15.0-bundle33-template-v3`. Uses a separate prewarmed package cache; existing v1/v2 caches and publications remain supported.
- Figures: TikZ for diagrams and PGFPlots for numeric plots; `tabularx`, `multirow`, and `siunitx` supplement existing table packages. No external programs, runtime downloads, custom fonts, or supporting files are required.

`agent-system.txt` supplies the report writer's instructions. The authenticated live API uploads `ofintech-logo.png` as the workflow's immutable image resource and saves `report.tex` in its PDF template block. Publishing and testing use the existing workflow API. Credentials are read from the local environment and are never stored here.
