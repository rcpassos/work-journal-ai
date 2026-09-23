import { describe, expect, it } from 'vitest'
import { projectOptions, projectPrefix } from './project-options'

// The rule every Project field offers its choices by, tested apart from any
// field: History's per-Note picker and a repository's Project Mapping field
// read the same list, and the list is what "the same completion" means.

describe('projectOptions', () => {
  it('offers the surface’s own name first, even once the journal names it too', () => {
    const options = projectOptions(
      '',
      ['alpha', 'work-journal-ai'],
      null,
      'work-journal-ai',
    )

    expect(options.map((option) => option.label)).toEqual([
      '#work-journal-ai',
      '#alpha',
    ])
  })

  it('offers Unfiled only while nothing has been typed and one is filed', () => {
    expect(
      projectOptions('', ['alpha'], 'alpha').map((option) => option.label),
    ).toEqual(['Unfiled', '#alpha'])
    // Typing is naming a Project: the absence of one is no longer the
    // question — though the shorter name being typed is still a name of its
    // own, and is offered beside the Prediction that matched.
    expect(
      projectOptions('al', ['alpha'], 'alpha').map((option) => option.label),
    ).not.toContain('Unfiled')
    expect(
      projectOptions('', ['alpha'], null).map((option) => option.label),
    ).toEqual(['#alpha'])
  })

  it('offers the name being typed as itself, and never twice', () => {
    expect(
      projectOptions('beta', [], null).map((option) => option.label),
    ).toEqual(['#beta'])
    expect(
      projectOptions('alpha', ['alpha'], null).map((option) => option.label),
    ).toEqual(['#alpha'])
  })

  it('never offers a name the record would refuse, suggested or typed', () => {
    expect(projectOptions('not a name', [], null)).toEqual([])
    expect(projectOptions('', [], null, 'not a name')).toEqual([])
  })

  it('names a Project as it is stored', () => {
    expect(projectOptions('HaBiC', [], null)[0]).toMatchObject({
      label: '#habic',
      name: 'habic',
    })
    // The suggestion too: a repository name is offered, not assumed, and what
    // is offered is the Project picking it would file under.
    expect(projectOptions('', [], null, 'Work_Journal')[0]).toMatchObject({
      label: '#work_journal',
      name: 'work_journal',
    })
    expect(projectPrefix('  #HaBiC  ')).toBe('HaBiC')
  })
})
